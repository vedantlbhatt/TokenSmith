// Prints each case's passages and its real answers split into the review's sentences, for labeling.
import { readFileSync } from 'node:fs'
import { answerSentences } from './lib.mjs'
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const cases = JSON.parse(readFileSync('tests/benchmarks/buzzdb_verify_cases.json', 'utf8'))
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : undefined
for (const c of cases) {
  if (only && !only.has(c.caseId)) continue
  const answers = rows.filter(r => r.caseId === c.caseId)
  if (!answers.length) continue
  console.log(`\n################ ${c.caseId} (${c.split}) Q: ${c.question}`)
  const used = new Set(answers.flatMap(a => a.passageIds))
  for (const p of c.passages) if (used.has(p.id)) console.log(`--- passage ${p.id}: ${p.text.replace(/\s+/g, ' ')}`)
  for (const a of answers) {
    console.log(`\n=== ${a.id} passages=${a.passageIds.join(',')}`)
    for (const s of answerSentences(a.answer)) console.log(`  [${s.id}${s.section === 'background' ? ' bg' : ''}] ${s.text}`)
  }
}
