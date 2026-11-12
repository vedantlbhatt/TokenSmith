// One sentence per call: embed sentence + passage windows (nomic), give the top 2 windows, ask a 3-way question.
import { readFileSync, writeFileSync } from 'node:fs'
// run from the repo root
const { requireTranspiledTs } = await import(new URL('../../unit/typescript/ts-module-loader.mjs', import.meta.url))
const { answerSentences } = requireTranspiledTs('src/main/engine/answer-review.ts')
const E = process.env.TOKENSMITH_EVAL_DIR ?? '../tokensmith-eval/'
const answers = JSON.parse(readFileSync(E + 'exp150.json', 'utf8'))
const labels = new Map(JSON.parse(readFileSync(E + 'labels150.json', 'utf8')).map(x => [x.id, x.label]))
const ids = process.argv[2].split(',').filter(Boolean).map(Number)
const O = 'http://127.0.0.1:11434'
const embed = async input => (await fetch(O + '/api/embed', { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', input }) }).then(r => r.json())).embeddings
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2 } return d / Math.sqrt(x * y) }
const split = t => t.replace(/```[\s\S]*?```/g, ' ').split(/\n+/).flatMap(l => l.split(/(?<=[.!?])\s+(?=[A-Z0-9("'`*])/)).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 4)
const instruction = 'You check one statement against a short excerpt from a textbook. Answer from the excerpt only, not from your own knowledge.\n' +
  'SUPPORTED: the excerpt states this or it follows directly.\nCONTRADICTED: the excerpt says something incompatible (negation, which thing does what, numbers, order, a different definition).\n' +
  'NOT_MENTIONED: the excerpt does not cover what the statement claims.\nReturn JSON {"verdict": ...}.'
const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['SUPPORTED', 'CONTRADICTED', 'NOT_MENTIONED'] } }, required: ['verdict'] }
const results = []
for (const id of ids) {
  const item = answers[id - 1]; const t0 = performance.now()
  const sents = answerSentences(item.answer).map(s => s.text)
  const sentencesOfPassages = item.passages.flatMap(p => split(p))
  const windows = sentencesOfPassages.map((_, i) => sentencesOfPassages.slice(Math.max(0, i - 1), i + 2).join(' '))
  const [wv, sv] = [await embed(windows), await embed(sents)]
  const verdicts = []
  for (const [i, s] of sents.entries()) {
    const top = wv.map((v, j) => [cos(v, sv[i]), j]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, j]) => windows[j])
    const r = await fetch(O + '/api/chat', { method: 'POST', body: JSON.stringify({ model: 'llama3.2', stream: false, think: false, format: schema,
      messages: [{ role: 'system', content: instruction }, { role: 'user', content: `Excerpt:\n${top.join('\n')}\n\nStatement: ${s}` }],
      options: { temperature: 0, num_ctx: 4096, num_predict: 20 } }) }).then(r => r.json())
    verdicts.push(JSON.parse(r.message.content).verdict)
  }
  const ms = Math.round(performance.now() - t0)
  results.push({ id, label: labels.get(id), ms, verdicts, sents })
  writeFileSync(process.argv[3], JSON.stringify(results, null, 1))
  console.log(id, labels.get(id), ms + 'ms', verdicts.map(v => v[0]).join(''))
}
