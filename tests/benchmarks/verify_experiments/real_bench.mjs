// Verify answer on 150 real llama3.2 answers with their real retrieved passages.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
// run from the repo root
const { requireTranspiledTs } = await import(new URL('../../unit/typescript/ts-module-loader.mjs', import.meta.url))
const { reviewOllamaAnswer } = requireTranspiledTs('src/main/engine/ollama-service.ts')
const E = process.env.TOKENSMITH_EVAL_DIR ?? '../tokensmith-eval/'
const answers = JSON.parse(readFileSync(E + 'exp150.json', 'utf8'))
const labels = new Map(JSON.parse(readFileSync(E + 'labels150.json', 'utf8')).map(x => [x.id, x.label]))
const out = process.argv[2]
const results = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
const done = new Set(results.map(r => r.id))
const model = { id: 'ollama:llama3.2', name: 'llama3.2', engine: 'ollama', status: 'ready', ollamaModelName: 'llama3.2', contextLength: 16384 }
for (const [index, item] of answers.entries()) {
  const id = index + 1
  if (done.has(id)) continue
  const sources = item.passages.map((text, i) => ({ title: `Passage ${i + 1}`, locator: '', excerpt: text }))
  const started = performance.now(); let review, error
  try { review = await reviewOllamaAnswer({ question: item.question, answer: item.answer, sources, model, modelSettings: { contextLength: 16384, temperature: 0.2 } }) }
  catch (e) { error = e.message }
  const verdicts = review?.claims.map(c => c.verdict) ?? []
  results.push({ id, label: labels.get(id), question: item.question, durationMs: Math.round(performance.now() - started), error,
    flagged: verdicts.some(v => v === 'contradicted' || v === 'unsupported'), verdicts, review })
  writeFileSync(out, JSON.stringify(results, null, 1))
  console.log(`${id} ${labels.get(id)}: ${error ? 'ERROR ' + error : verdicts.join(',')}`)
}
const by = {}
for (const r of results) { const b = by[r.label] ??= { n: 0, flagged: 0, errors: 0 }; b.n++; if (r.error) b.errors++; else if (r.flagged) b.flagged++ }
console.log('\nflagged by label:', JSON.stringify(by))
const d = results.filter(r => !r.error).map(r => r.durationMs).sort((a, b) => a - b)
console.log('p50', d[Math.floor(d.length / 2)], 'p95', d[Math.floor(d.length * 0.95)])
