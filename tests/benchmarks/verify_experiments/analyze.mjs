// Scores design runs against the labels in buzzdb_real_answers.json.
//   node tests/benchmarks/verify_experiments/analyze.mjs run1.json [run2.json ...]
// Answer level: "bad" = partly_wrong or wrong. A hard flag is any collection
// sentence marked contradicted or unsupported. For designs with scores, the answer
// score is the max sentence score; AUC is reported (0.5 = chance).
// Sentence level: positives are labeled wrong sentences, negatives are sentences
// of answers labeled correct. "strict" drops answers marked borderline.
import { readFileSync } from 'node:fs'
import { auc } from './lib.mjs'
const labels = new Map(JSON.parse(readFileSync('tests/benchmarks/buzzdb_real_answers.json', 'utf8')).answers.map(a => [a.id, a]))
const flagged = v => v === 'contradicted' || v === 'unsupported'
const pct = (a, b) => `${a}/${b}`
for (const file of process.argv.slice(2)) {
  const runs = JSON.parse(readFileSync(file, 'utf8'))
  const report = (name, rows) => {
    const bad = rows.filter(r => labels.get(r.id).label !== 'correct'), good = rows.filter(r => labels.get(r.id).label === 'correct')
    const flag = r => r.sentences.some(s => flagged(s.verdict))
    const line = [`${name}: n=${rows.length}`, `hard flag: bad ${pct(bad.filter(flag).length, bad.length)}, correct ${pct(good.filter(flag).length, good.length)}`]
    // Sentence-level hard verdicts.
    const pos = [], neg = []
    for (const r of rows) {
      const L = labels.get(r.id)
      const wrong = new Set(L.wrongSentences.filter(w => !w.borderline).map(w => w.id))
      const borderlineWrong = new Set(L.wrongSentences.filter(w => w.borderline).map(w => w.id))
      r.sentences.forEach((s, i) => {
        if (wrong.has(i + 1)) pos.push(s)
        else if (L.label === 'correct' && !borderlineWrong.has(i + 1)) neg.push(s)
      })
    }
    line.push(`sent flag: wrong ${pct(pos.filter(s => flagged(s.verdict)).length, pos.length)}, ok ${pct(neg.filter(s => flagged(s.verdict)).length, neg.length)}`)
    if (rows[0]?.sentences[0]?.score !== undefined) {
      const score = r => Math.max(...r.sentences.map(s => s.score ?? 0))
      line.push(`AUC answer ${auc(bad.map(score), good.map(score)).toFixed(2)}, sentence ${auc(pos.map(s => s.score), neg.map(s => s.score)).toFixed(2)}`)
    }
    if (rows[0]?.sentences[0]?.sim !== undefined) {
      const minSim = r => -Math.min(...r.sentences.map(s => s.sim))
      line.push(`AUC(-sim) answer ${auc(bad.map(minSim), good.map(minSim)).toFixed(2)}, sentence ${auc(pos.map(s => -s.sim), neg.map(s => -s.sim)).toFixed(2)}`)
    }
    const ms = rows.map(r => r.ms).sort((a, b) => a - b)
    line.push(`p50 ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)}s, calls ~${(rows.reduce((t, r) => t + r.calls, 0) / rows.length).toFixed(1)}`)
    console.log(line.join(' | '))
  }
  console.log('==', file.split('/').pop())
  report('all', runs)
  report('strict', runs.filter(r => !labels.get(r.id).borderline))
}
