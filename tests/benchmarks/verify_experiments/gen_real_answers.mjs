// Generates real llama3.2 answers to the BuzzDB verify questions with the app's own
// answer path (runOllamaStudyEngine, reasoning off), using each case's passages as
// the retrieved sources. Several seeds per question give more real answers.
//
//   node tests/benchmarks/verify_experiments/gen_real_answers.mjs out.json [seeds=1,2,3]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { requireTranspiledTs } from '../../unit/typescript/ts-module-loader.mjs'

const { runOllamaStudyEngine } = requireTranspiledTs('src/main/engine/ollama-service.ts')
const out = process.argv[2]
const seeds = (process.argv[3] ?? '1,2,3').split(',').map(Number)
const cases = JSON.parse(readFileSync('tests/benchmarks/buzzdb_verify_cases.json', 'utf8'))
const modelName = process.env.MODEL ?? 'llama3.2'
const model = { id: 'gen', name: modelName, ollamaModelName: modelName, engine: 'ollama', source: 'ollama',
  role: 'generator', status: 'ready', contextLength: 8192 }
// Same generation settings as tests/benchmarks/buzzdb_reasoning.mjs.
const modelSettings = { contextLength: 8192, maxLength: 1536, temperature: 0.7, topP: 0.4,
  topK: 40, minP: 0, repeatPenalty: 1.18, reasoningMode: 'off', systemMessage: '' }
const applicationSettings = { suggestionMode: 'off', searchMode: 'hybrid', explanationDepthEnabled: false }
const base = { model, modelSettings, applicationSettings, materials: [{ id: '1', status: 'ready', isActive: true }],
  settings: { maxSources: 4, application: applicationSettings, modelDefaults: modelSettings, modelSettingsById: {} } }

let seed
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  if (String(url).endsWith('/api/chat') && init?.body) {
    const body = JSON.parse(init.body)
    init = { ...init, body: JSON.stringify({ ...body, options: { ...body.options, seed } }) }
  }
  return realFetch(url, init)
}

const rows = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
const done = new Set(rows.map(r => r.id))
for (const s of seeds) for (const item of cases) {
  const id = `${item.caseId}#${s}`
  if (done.has(id)) continue
  seed = s
  const retrievedSources = item.passages.map(p => ({ title: p.title, locator: p.id, excerpt: p.text }))
  const t = performance.now()
  try {
    const res = await runOllamaStudyEngine({ ...base, prompt: item.question, messages: [], reasoning: false, retrievedSources })
    rows.push({ id, caseId: item.caseId, split: item.split, seed: s, question: item.question,
      passageIds: res.sources.map(x => x.locator), answer: res.text, generationMs: Math.round(performance.now() - t) })
  } catch (e) { console.log(id, 'ERROR', e.message); continue }
  writeFileSync(out, JSON.stringify(rows, null, 1) + '\n')
  console.log(id, Math.round(performance.now() - t) + 'ms', rows.at(-1).answer.length + ' chars')
}
