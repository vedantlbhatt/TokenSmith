// Tunes a sentence-score rule on dev runs and applies it, frozen, to held-out runs.
//   node tests/benchmarks/verify_experiments/combine.mjs <design> <devDir-prefix> <heldoutDir-prefix>
// Inputs are run files <prefix><design>_dev.json and <prefix>lexical_dev.json (and _heldout).
// Rule: score = w * modelScore + (1 - w) * lexicalNovelty; a sentence is flagged
// when score > t. w and t are picked on dev to maximize sentence-level TPR - FPR.
// Answer flag = any sentence flagged. Held-out numbers use the dev w and t.
import { readFileSync, existsSync } from 'node:fs'
import { auc } from './lib.mjs'
const labels = new Map(JSON.parse(readFileSync('tests/benchmarks/buzzdb_real_answers.json', 'utf8')).answers.map(a => [a.id, a]))
const [design, prefix, split2 = 'heldout'] = process.argv.slice(2)
const load = (d, split) => { const f = `${prefix}${d}_${split}.json`; return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined }
function rows(split) {
  const m = design === 'lexical' ? undefined : load(design, split), lex = load('lexical', split)
  if (!lex || (design !== 'lexical' && !m)) return undefined
  const lexBy = new Map(lex.map(r => [r.id, r]))
  return (m ?? lex).map(r => ({ id: r.id, ms: r.ms + (m ? 0 : 0), sents: r.sentences.map((s, i) => ({ model: m ? s.score : 0, lex: lexBy.get(r.id).sentences[i].score })) }))
}
function evaluate(data, w, t, strict = false) {
  let tp = 0, fn = 0, fp = 0, tn = 0, ab = 0, abf = 0, ag = 0, agf = 0
  for (const r of data) {
    const L = labels.get(r.id)
    if (strict && L.borderline) continue
    const wrong = new Set(L.wrongSentences.filter(x => !x.borderline).map(x => x.id))
    const bw = new Set(L.wrongSentences.filter(x => x.borderline).map(x => x.id))
    let any = false
    r.sents.forEach((s, i) => {
      const f = w * s.model + (1 - w) * s.lex > t
      any ||= f
      if (wrong.has(i + 1)) f ? tp++ : fn++
      else if (L.label === 'correct' && !bw.has(i + 1)) f ? fp++ : tn++
    })
    if (L.label === 'correct') { ag++; if (any) agf++ } else { ab++; if (any) abf++ }
  }
  // Threshold-free answer-level AUC of max combined sentence score.
  const sc = r => Math.max(...r.sents.map(s => w * s.model + (1 - w) * s.lex))
  const use = data.filter(r => !(strict && labels.get(r.id).borderline))
  const aucA = auc(use.filter(r => labels.get(r.id).label !== 'correct').map(sc), use.filter(r => labels.get(r.id).label === 'correct').map(sc))
  return { tpr: tp / (tp + fn), fpr: fp / (fp + tn), tp, fn, fp, tn, ab, abf, ag, agf, aucA }
}
const dev = rows('dev')
let best
const ws = design === 'lexical' ? [0] : [0, 0.25, 0.5, 0.75, 1]
for (const w of ws) for (let t = 0; t <= 1; t += 0.02) {
  const e = evaluate(dev, w, t); const j = e.tpr - e.fpr
  if (!best || j > best.j) best = { w, t, j, e }
}
const fmt = (e) => `sentences: wrong flagged ${e.tp}/${e.tp + e.fn}, ok flagged ${e.fp}/${e.fp + e.tn} | answers: bad flagged ${e.abf}/${e.ab}, correct flagged ${e.agf}/${e.ag} | answer AUC ${e.aucA.toFixed(2)}`
console.log(`${design}: frozen w=${best.w} t=${best.t.toFixed(2)} (dev J=${best.j.toFixed(2)})`)
console.log('  dev     ', fmt(best.e))
const ho = rows(split2)
if (ho) { console.log(`  ${split2} `, fmt(evaluate(ho, best.w, best.t))); console.log(`  ${split2} strict`, fmt(evaluate(ho, best.w, best.t, true))) }
