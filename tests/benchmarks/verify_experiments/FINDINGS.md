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
