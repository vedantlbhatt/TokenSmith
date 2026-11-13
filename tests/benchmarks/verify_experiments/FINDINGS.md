# Verify answer: findings so far

Context: PR georgia-tech-db/TokenSmith#140. Reviewer (jarulraj, 10 Nov 2026) asked to drop the NLI
runtime and High/Medium/Low badges and instead add an optional **Verify answer** button that reuses
the model that generated the answer (no extra download), shows supported / contradicted /
unsupported claims and missing assumptions with passage links, keeps the original answer visible,
is labeled a review (not a guarantee), and is tested on correct and deliberately wrong answers
(role swaps, negation, numeric errors, unsupported claims) with latency recorded. No specific model
is named; the dev machine has llama3.2 (3B), so all numbers below are llama3.2.

## Built (this branch)
- `src/main/engine/answer-review.ts`: sentence splitting, prompt, per-request strict JSON schema,
  parser. `reviewOllamaAnswer` / `reviewRemoteAnswer`, IPC `engine:review-answer`.
- `src/renderer/src/AnswerReview.tsx` + Verify button in `AnswerExplanation.tsx`, handler
  `verifyAnswer` in `App.tsx`, request builders in `chat-interactions.ts`.
- Answers record `answerContext.modelId`; reviews stored per answer version in `answerReviews`.
- Tests: `tests/unit/typescript/answer-review.test.mjs` (17), full TS suite 467/467, typecheck clean.
- Verified end to end in the running Electron app.

## Results (llama3.2). "Flagged" = any sentence contradicted or unsupported.
| Design | Test set | Wrong caught | Correct flagged |
|---|---|---|---|
| Model picks its own claims | planted, 3 q | looped / listed passage claims | - |
| Per-sentence verdicts (shipped) | planted held-out | 34/56 | 7/24 |
| Must quote passage, code checks quote | planted 230 | 153/160 | 68/70 (flags everything) |
| Cite passage sentence ids | planted 17 | 8/17 right | |
| Per-sentence verdicts | real 48 | 14/26 | 14/20 |
| Majority rule on top | real 48 | 3/26 | 1/20 |
| Restate passage first | real 15 | 6/9 | 4/5 |
| Two calls: facts (no answer visible), then compare | real 1-15 | 9/9 | 3/5 |
| Same, frozen rules, fresh real 16-45 | real 30 | 15/16 (any) / 7/16 (<70%) | 10/14 / 10/14 |

Latency: ~5 s on short planted answers, ~22-24 s on real answers with 8 passages.

"Planted" = `tests/benchmarks/buzzdb_verify_cases.json` (35 BuzzDB questions, hand-written correct
and deliberately wrong answers; dev 23 / held-out 12). "Real" = 150 real llama3.2 answers on the
Silberschatz textbook with their retrieved passages and labels (correct / partly_wrong / wrong /
correct_ungrounded); NOT in this repo (copyrighted text). Labels were made in an earlier session,
author unrecorded, and are loose (some "correct" answers contain unsupported sentences).

## Why it fails
- Wrong sentences marked supported: role swaps (OLTP/OLAP swapped) pass because every word is in the passage.
- Correct sentences marked wrong: the book's own example marked "different".
- When asked to quote or restate the passage, llama3.2 copies the answer sentence instead.
- On real answers, correct and wrong answers get about the same share of supported sentences
  (79% vs 81-83%), so no aggregation rule separates them.

## Rules for further experiments
- Small sets (10-15 answers) to iterate fast; freeze any rule/threshold before testing it on fresh answers.
- Headline only held-out / fresh numbers; report the "flag everything" baseline beside them.
- Untested ideas: one sentence per call with only its top 1-2 passage windows (nomic embeddings),
  "what would make this false?", self-consistency over 2-3 samples, comparing only the sentence's key relation.

## Experiment scripts
`verify_experiments/*.mjs` were run locally against the real-answer files in a sibling
`tokensmith-eval` folder (paths are hardcoded); adapt them to BuzzDB or regenerated answers.

## Round 2 (Nov 2026): real BuzzDB answers, per-sentence designs

### Test set
`tests/benchmarks/buzzdb_real_answers.json`: 105 real llama3.2 answers (35 BuzzDB questions x seeds 1-3),
generated with the app's own answer path (`runOllamaStudyEngine`, reasoning off, temperature 0.7, topP 0.4)
from each case's passages (`gen_real_answers.mjs`). **Labels were made by Claude (an AI model), not a human**,
sentence by sentence against the passages, with a reason for every wrong sentence. Sentence ids are those
of `answerSentences()`. About a third of labels are marked `borderline` (a careful reader could call them
the other way); "strict" rows below drop those answers.

| Split | Answers | correct | partly_wrong | wrong | wrong sentences (non-borderline) |
|---|---|---|---|---|---|
| dev | 69 | 44 | 25 | 0 | 29 |
| held-out | 36 | 25 | 10 | 1 | 19 |

Real llama3.2 errors are mostly unsupported additions (invented reasons, trade-offs, generic claims) and some
garbled roles ("the next pointer" as separator keys, column A as a DIRECT operand), not clean negations.

### Machine
4-CPU container, no GPU, Ollama 0.40. Everything is about 2-3x slower than the dev laptop (the shipped review
takes ~74 s p50 here vs ~25 s there), so latency is compared against the shipped design on the same box.

### Designs tried (`designs.mjs`, scored by `analyze.mjs` and `combine.mjs`)
- `shipped`: the branch's one-call review.
- `twocall`: facts from passages, then compare (round 1 design).
- `persent`: one call per sentence with its top 2 passage windows (nomic-embed-text), hard 3-way verdict.
- `lp`: one call per sentence with its top 3 windows, "Is the statement supported by the excerpt? Yes or No",
  1 output token; the score is P(No) from Ollama logprobs (renormalized over yes/no).
- `lpEvery`: same, asking whether the excerpt says everything the statement says.
- `lp3`: same, one-word supported / contradicted / missing, read from first-token logprobs.
- `lpBatch`: one call, all passages and sentences, constrained yes/no per sentence, scored from each verdict
  token's logprobs.
- `lexical` (no model): share of the sentence's content words (stemmed, minus question words) that appear
  nowhere in the passages.
- Not finished: `lpK5`, `lpQ` (question in prompt), `lpK1`, `lpFalse` ("what does the excerpt say / what detail
  differs?" before the Yes/No). Stopped to get to held-out; only 4 `lpK5` answers ran.

### Dev, first 15 answers (6 bad / 9 correct, 7 wrong sentences, 62 sentences of correct answers)
| Design | Answers: bad / correct flagged | Sentences: wrong / ok flagged | Sentence AUC | p50 |
|---|---|---|---|---|
| shipped | 6/6, 5/9 | 2/7, 10/62 | - | 74 s |
| twocall | 6/6, 8/9 | 4/7, 23/62 | - | 70 s |
| persent | 5/6, 8/9 | 4/7, 31/62 | - | 19 s |
| lp (hard 0.5 cut) | 6/6, 8/9 | 3/7, 18/62 | 0.72 | 16 s |
| lpEvery | 6/6, 9/9 | 7/7, 62/62 | 0.57 | 11 s |
| flag everything | 6/6, 9/9 | 7/7, 62/62 | 0.50 | 0 |

### Dev, all 69 answers (25 bad / 44 correct; 29 wrong sentences, 252 sentences of correct answers)
| Design | Sentence AUC | Answer AUC (max sentence score) | p50 |
|---|---|---|---|
| lp | 0.76 (strict 0.80) | 0.67 | 13 s |
| lp3 | 0.69 | 0.62 | 13 s |
| lpBatch (1 call) | 0.62 | 0.50 | 7.5 s |
| lexical (no model) | 0.75 (strict 0.79) | 0.67 | <3 s (embedding of windows only) |

Combining scores (`combine.mjs`): score = w * lp + (1 - w) * lexical, sentence flagged if score > t; w and t
chosen on dev. Two objectives were tried on dev: sentence TPR - FPR (J) and sentence F1.

### Held-out (36 answers: 11 bad / 25 correct; 19 wrong sentences, 197 sentences of correct answers)
Rules frozen on dev before running held-out. Flag-everything baseline: answers 11/11 and 25/25, sentences 19/19 and 197/197.

| Rule (frozen on dev) | Sentences: wrong / ok flagged | Answers: bad / correct flagged | Answer AUC | p50 |
|---|---|---|---|---|
| lp + lexical, w=0.25, t=0.30 (J) | 17/19, 87/197 | 11/11, 22/25 | 0.72 | 17 s (~8 calls) |
| lp + lexical, w=0.5, t=0.52 (F1) | 9/19, 47/197 | 11/11, 21/25 | 0.73 | 17 s |
| lexical only, t=0.38 (F1) | 14/19, 31/197 | 10/11, 15/25 | 0.77 | <3 s, 0 LLM calls |
| lexical only, t=0.16 (J) | (dev: 25/29, 125/252) | (dev: 25/25, 37/44) | 0.67 dev | |
| shipped (34 of 36; 2 failed with 'structured response exceeded its output limit') | 1/15, 17/197 | 5/9, 12/25 | - | 78 s |

Fisher exact tests on held-out: sentence-level, both lp+lexical (p = 1.5e-4) and lexical (p = 2.5e-7) flag
wrong sentences far more often than ok ones. Answer-level, neither separates bad from correct answers
significantly (lexical F1 rule p = 0.12, lp J rule p = 0.54). Caveat: two objectives were tried and both are
shown, so the lexical F1 row is the better of two looks at held-out.

The shipped one-call review is at chance on held-out real answers: it flags 7% of wrong sentences and 9% of ok
ones, and 56% of bad answers vs 48% of correct ones.

### Conclusions
1. **No design separates correct from wrong whole answers on held-out at a useful level.** The best rule still
   flags 15/25 correct answers (vs 10/11 bad). With ~7-9 sentences per answer, even a decent sentence-level
   detector fires somewhere in most correct answers, and many "correct" answers contain loose sentences.
2. **Per-sentence scoring does carry signal**, unlike the shipped one-call review: the per-sentence logprob
   score ranks wrong sentences above ok ones (AUC 0.76 dev, 0.64 held-out alone) and is ~5x faster on this box
   than the shipped review, because each call reads one sentence and ~3 short windows and writes one token.
3. **Most of that signal is word overlap.** The no-model "novel content words" score matches or beats the
   model on held-out. llama3.2's errors on real answers are mainly additions not in the passages, which word
   overlap catches; it cannot catch role swaps or negations that reuse the passage's words.
4. **Asking for a hard verdict throws the signal away.** Hard 3-way verdicts (shipped, persent, lp3) are near
   chance; reading P(No) from logprobs and setting the cut on dev is what makes `lp` usable.
5. One call with logprobs per sentence (`lpBatch`) does not work: inside a long JSON answer the verdict-token
   probabilities are nearly uninformative (sentence AUC 0.62).

### Decision
The implementation in `answer-review.ts` is unchanged: no design clearly beat the flag-everything baseline on
held-out answers, which was the bar for replacing it. If the review is reworked, the evidence points to:
per-sentence calls with the 3 best windows and a logprob score, plus a word-overlap "not in the passages" hint,
presented as "check these sentences" with the passage window shown, not as verdicts on the whole answer.
Window selection would also need to avoid a hard dependency on nomic-embed-text (the app's embedding model is
per material); a word-overlap window ranker was added (`WINDOWS=lexical`) but not evaluated.

### Reproduce
```
node tests/benchmarks/verify_experiments/gen_real_answers.mjs out.json 1,2,3
node tests/benchmarks/verify_experiments/designs.mjs <design> <dev|heldout> runs/<design>_<split>.json [limit]
node tests/benchmarks/verify_experiments/analyze.mjs runs/<design>_dev.json
node tests/benchmarks/verify_experiments/combine.mjs <design> runs/
```
