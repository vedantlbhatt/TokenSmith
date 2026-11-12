import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import type { AnswerReview as AnswerReviewData, ChatSource, ReviewClaim, ReviewVerdict } from '@shared/app-state'
import { MessageText } from './MessageText'

const groups: Array<{ verdict: ReviewVerdict; title: string }> = [
  { verdict: 'contradicted', title: 'Contradicted by the sources' },
  { verdict: 'unsupported', title: 'Not found in the sources' },
  { verdict: 'supported', title: 'Supported by the sources' },
  { verdict: 'background', title: 'General background, not from your materials' }
]

const countLabels: Record<ReviewVerdict, string> = {
  contradicted: 'contradicted',
  unsupported: 'not in sources',
  supported: 'supported',
  background: 'background'
}

function reviewSummary(claims: ReviewClaim[]): string {
  return groups
    .map(({ verdict }) => [verdict, claims.filter((claim) => claim.verdict === verdict).length] as const)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${count} ${countLabels[verdict]}`)
    .join(' · ')
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

export function AnswerReviewPending({ onCancel }: { onCancel?: () => void }) {
  return <div className="answer-review answer-review-pending" role="status">
    <Loader2 className="spin" size={16} aria-hidden="true" />
    <span>Checking each claim against this answer&apos;s sources…</span>
    {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
  </div>
}

export function AnswerReview({ review, onOpenSource }: {
  review: AnswerReviewData
  onOpenSource: (source: ChatSource, sources: ChatSource[]) => void
}) {
  const [showCorrection, setShowCorrection] = useState(false)
  return <section className="answer-review" aria-label="Review of this answer">
    <header>
      <ShieldCheck size={17} aria-hidden="true" />
      <h4>Review of this answer</h4>
      <span className="answer-review-summary">{reviewSummary(review.claims)}</span>
    </header>
    <p className="answer-review-caveat">
      {review.sameModel
        ? `Checked by ${review.modelName}, the same model that wrote the answer, so it can repeat the answer's mistakes.`
        : `Checked by ${review.modelName}.`}
      {' '}This is a review, not a guarantee that the answer is correct.
    </p>
    {groups.map(({ verdict, title }) => {
      const claims = review.claims.filter((claim) => claim.verdict === verdict)
      if (claims.length === 0) return null
      return <div className={`answer-review-group verdict-${verdict}`} key={verdict}>
        <h5>{title}</h5>
        <ul>
          {claims.map((claim) => <li key={claim.claim}>
            <p className="answer-review-claim">{claim.claim}</p>
            {claim.evidence && <blockquote className="answer-review-evidence">{claim.evidence}</blockquote>}
            {claim.note && <p className="answer-review-note">{claim.note}</p>}
            {claim.passages.length > 0 && <div className="answer-review-passages">
              {claim.passages.map((number) => {
                const source = review.sources[number - 1]
                return source && <button type="button" key={number} title={`${source.title}${source.locator ? `, ${source.locator}` : ''}`}
                  onClick={() => onOpenSource(source, review.sources)}>
                  Source {number}
                </button>
              })}
            </div>}
          </li>)}
        </ul>
      </div>
    })}
    {review.missingAssumptions.length > 0 && <div className="answer-review-group verdict-assumption">
      <h5>Assumptions the answer relies on</h5>
      <ul>{review.missingAssumptions.map((assumption) => <li key={assumption}><p className="answer-review-claim">{assumption}</p></li>)}</ul>
    </div>}
    {review.correctedExplanation && <div className="answer-review-correction">
      <button type="button" aria-expanded={showCorrection} onClick={() => setShowCorrection((open) => !open)}>
        {showCorrection ? 'Hide corrected explanation' : 'Show corrected explanation'}
      </button>
      {showCorrection && <div className="answer-review-correction-text">
        <p className="answer-review-caveat">Suggested by the reviewer from the sources. The original answer above is unchanged.</p>
        <MessageText text={review.correctedExplanation} />
      </div>}
    </div>}
    <p className="answer-review-footer">Review took {seconds(review.durationMs)}</p>
  </section>
}
