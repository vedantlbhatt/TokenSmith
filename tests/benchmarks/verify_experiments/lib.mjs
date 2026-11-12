// Shared helpers for the Verify answer experiments on real BuzzDB answers.
import { readFileSync } from 'node:fs'
import { requireTranspiledTs } from '../../unit/typescript/ts-module-loader.mjs'

export const { answerSentences } = requireTranspiledTs('src/main/engine/answer-review.ts')
export const O = process.env.OLLAMA ?? 'http://127.0.0.1:11434'
export const MODEL = process.env.MODEL ?? 'llama3.2'

const cases = new Map(JSON.parse(readFileSync('tests/benchmarks/buzzdb_verify_cases.json', 'utf8')).map(c => [c.caseId, c]))

// Real answers with their labels and the passages the answer was generated from.
export function loadReal(split, limit = Infinity, offset = 0) {
  const rows = JSON.parse(readFileSync('tests/benchmarks/buzzdb_real_answers.json', 'utf8')).answers
  const only = process.env.IDS ? new Set(process.env.IDS.split(',')) : undefined
  return rows.filter(r => (split === 'all' || r.split === split) && (!only || only.has(r.id))).slice(offset, offset + limit).map(r => {
    const c = cases.get(r.caseId)
    const passages = r.passageIds.map(id => c.passages.find(p => p.id === id))
    return { ...r, passages, sentences: answerSentences(r.answer) }
  })
}

export async function chat(messages, { format, num_predict = 400, num_ctx = 4096, temperature = 0, seed, logprobs = false, top_logprobs = 0 } = {}) {
  const body = { model: MODEL, messages, stream: false, think: false, format,
    options: { temperature, num_ctx, num_predict, ...(seed !== undefined ? { seed } : {}) } }
  if (logprobs) Object.assign(body, { logprobs: true, top_logprobs })
  const r = await fetch(O + '/api/chat', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json())
  if (r.error) throw new Error(r.error)
  return r
}

export async function embed(input) {
  const r = await fetch(O + '/api/embed', { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', input }) }).then(r => r.json())
  return r.embeddings
}
export const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2 } return d / Math.sqrt(x * y) }

// Passage text split into sentences, then 3-sentence windows around each one.
export function passageWindows(passages) {
  const out = []
  passages.forEach((p, pi) => {
    const sents = p.text.replace(/```[\s\S]*?```/g, ' ').replace(/^#+ .*$/gm, ' ').replace(/Source excerpts:\s*$/, '')
      .split(/\n+/).flatMap(l => l.split(/(?<=[.!?])\s+(?=[A-Z0-9("'`*])/)).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 4)
    sents.forEach((_, i) => out.push({ passage: pi + 1, text: sents.slice(Math.max(0, i - 1), i + 2).join(' ') }))
  })
  return out
}

// P(first token is yes) from top logprobs, renormalized over yes/no variants.
export function pYes(response) {
  const top = response.logprobs?.[0]?.top_logprobs ?? []
  let y = 0, n = 0
  for (const t of top) {
    const w = t.token.trim().toLowerCase()
    if (w === 'yes') y += Math.exp(t.logprob)
    else if (w === 'no') n += Math.exp(t.logprob)
  }
  return y + n > 0 ? y / (y + n) : 0.5
}

// Ground truth: an answer is "bad" when labeled partly_wrong or wrong. A sentence
// is bad when listed in the answer's wrongSentences.
export const isBad = r => r.label !== 'correct'
export const badIds = r => new Set((r.wrongSentences ?? []).map(w => w.id))

export function auc(pos, neg) {
  // pos should score higher. Ties count half.
  if (!pos.length || !neg.length) return NaN
  let s = 0
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (pos.length * neg.length)
}

// Answer-level summary for a boolean flag per answer.
export function summarize(results, flagOf) {
  const bad = results.filter(isBad), good = results.filter(r => !isBad(r))
  const caught = bad.filter(flagOf).length, falseFlag = good.filter(flagOf).length
  return `bad caught ${caught}/${bad.length}, correct flagged ${falseFlag}/${good.length} (flag-everything: ${bad.length}/${bad.length}, ${good.length}/${good.length})`
}
