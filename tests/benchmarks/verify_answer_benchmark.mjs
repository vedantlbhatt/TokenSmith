// Runs Verify answer against a real local model on the BuzzDB cases.
//
//   node tests/benchmarks/verify_answer_benchmark.mjs [ollama-model] [out.json]
//
// Each case has a question, the passages retrieval should return plus known
// distractors, and answers of several kinds. reference and paraphrase are
// correct; negation, role_swap, numeric, fabricated, mixed and unanswerable are
// wrong in a known way. A wrong answer counts as caught when the review marks
// at least one claim contradicted or unsupported. A correct answer counts as
// wrongly flagged when it gets either. There are no thresholds to tune.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { requireTranspiledTs } from '../unit/typescript/ts-module-loader.mjs'

const { reviewOllamaAnswer } = requireTranspiledTs('src/main/engine/ollama-service.ts')
const { answerSentences } = requireTranspiledTs('src/main/engine/answer-review.ts')

// Keep the model's raw reply so each run can also be scored without the quote
// check: the model's own verdicts, with only the "must cite a passage" rule.
let lastRaw
const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  const response = await realFetch(url, options)
  if (!String(url).endsWith('/api/chat')) return response
  const payload = await response.json()
  lastRaw = payload.message?.content
  return { ok: response.ok, status: response.status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function verdictsWithoutQuoteCheck(raw, answerText) {
  try {
    const parsed = JSON.parse(raw)
    const byId = new Map(parsed.sentences.map((entry) => [entry.id, entry]))
    return answerSentences(answerText).map((sentence) => {
      const entry = byId.get(sentence.id)
      if (!entry) return sentence.section === 'background' ? 'background' : 'unsupported'
      let verdict = entry.verdict
      if (verdict !== 'unsupported' && !(entry.passages ?? []).length) verdict = 'unsupported'
      if (sentence.section === 'background' && verdict !== 'contradicted') verdict = 'background'
      return verdict
    })
  } catch { return [] }
}

const modelName = process.argv[2] ?? 'llama3.2'
const outPath = process.argv[3] ?? `verify-benchmark-${modelName.replace(/[^a-z0-9.]+/gi, '_')}.json`
const cases = JSON.parse(readFileSync(new URL('./buzzdb_verify_cases.json', import.meta.url), 'utf8'))
  .slice(0, Number(process.env.VERIFY_CASES ?? Infinity))
const correctKinds = new Set(['reference', 'paraphrase'])
const model = { id: `ollama:${modelName}`, name: modelName, engine: 'ollama', status: 'ready', ollamaModelName: modelName, contextLength: 8192 }
const modelSettings = { contextLength: 8192, maxLength: 2048, temperature: 0.2 }

// Resume an interrupted run instead of starting over.
const done = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')).results : []
const key = (caseId, kind) => `${caseId}/${kind}`
const finished = new Set(done.map((result) => key(result.caseId, result.kind)))
const results = [...done]

for (const item of cases) {
  const sources = item.passages.map((passage) => ({ title: passage.title, locator: passage.id, excerpt: passage.text }))
  for (const answer of item.answers) {
    if (finished.has(key(item.caseId, answer.kind))) continue
    const started = performance.now()
    let review
    let error
    lastRaw = undefined
    try {
      review = await reviewOllamaAnswer({ question: answer.question ?? item.question, answer: answer.text, sources, model, modelSettings })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const verdicts = review?.claims.map((claim) => claim.verdict) ?? []
    const plain = lastRaw ? verdictsWithoutQuoteCheck(lastRaw, answer.text) : []
    const result = {
      caseId: item.caseId, split: item.split, kind: answer.kind, correctAnswer: correctKinds.has(answer.kind),
      durationMs: Math.round(performance.now() - started), error,
      flagged: verdicts.some((verdict) => verdict === 'contradicted' || verdict === 'unsupported'),
      contradicted: verdicts.includes('contradicted'),
      flaggedWithoutQuoteCheck: plain.some((verdict) => verdict === 'contradicted' || verdict === 'unsupported'),
      verdicts, plainVerdicts: plain, raw: lastRaw, review
    }
    results.push(result)
    writeFileSync(outPath, JSON.stringify({ model: modelName, results }, null, 1))
    console.log(`${result.caseId}/${result.kind}: ${error ? `ERROR ${error}` : verdicts.join(',')} (${result.durationMs} ms)`)
  }
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}
const kinds = [...new Set(results.map((result) => result.kind))]
console.log(`\nVerify answer on ${modelName}, ${results.length} answers`)
for (const kind of kinds) {
  const rows = results.filter((result) => result.kind === kind)
  const ok = rows.filter((result) => !result.error)
  const flagged = ok.filter((result) => result.flagged).length
  const contradicted = ok.filter((result) => result.contradicted).length
  const plain = ok.filter((result) => result.flaggedWithoutQuoteCheck).length
  const label = rows[0].correctAnswer ? 'wrongly flagged' : 'caught'
  console.log(`${kind.padEnd(13)} n=${String(rows.length).padStart(2)}  ${label} ${flagged}/${ok.length}` +
    `  (contradicted ${contradicted})  without quote check ${plain}/${ok.length}  errors ${rows.length - ok.length}`)
}
const correct = results.filter((result) => result.correctAnswer && !result.error)
const wrong = results.filter((result) => !result.correctAnswer && !result.error)
const durations = results.filter((result) => !result.error).map((result) => result.durationMs)
console.log(`\nWrong answers caught: ${wrong.filter((result) => result.flagged).length}/${wrong.length}`)
console.log(`Correct answers wrongly flagged: ${correct.filter((result) => result.flagged).length}/${correct.length}`)
console.log(`Without quote check: caught ${wrong.filter((result) => result.flaggedWithoutQuoteCheck).length}/${wrong.length}, wrongly flagged ${correct.filter((result) => result.flaggedWithoutQuoteCheck).length}/${correct.length}`)
console.log(`Errors: ${results.filter((result) => result.error).length}/${results.length}`)
console.log(`Added latency: p50 ${percentile(durations, 0.5)} ms, p95 ${percentile(durations, 0.95)} ms`)
