import assert from 'node:assert/strict'
import test from 'node:test'
import { requireTranspiledTs } from './ts-module-loader.mjs'

const { answerReviewMessages, answerSentences, parseAnswerReview, quoteInPassages, splitGeneralBackground, answerReviewSchema } =
  requireTranspiledTs('src/main/engine/answer-review.ts')
const { reviewOllamaAnswer } = requireTranspiledTs('src/main/engine/ollama-service.ts')
const { reviewRemoteAnswer } = requireTranspiledTs('src/main/engine/remote-chat-service.ts')
const { answerReviewRequest, canVerifyAnswer, displayedAnswerView, reviewModelFor } =
  requireTranspiledTs('src/renderer/src/chat-interactions.ts')

const sources = [
  { title: 'Buffer pool', locator: 'p. 4', excerpt: 'A pinned page cannot be evicted by the replacement policy.' },
  { title: 'Recovery', locator: 'p. 9', excerpt: 'The WAL protocol writes log records to disk before the data page.' }
]
const ollamaModel = { id: 'ollama:llama3.2', name: 'llama3.2', engine: 'ollama', status: 'ready', ollamaModelName: 'llama3.2', contextLength: 8192 }
const base = {
  question: 'Why pin pages?',
  answer: 'Pinning stops a page from being evicted while in use.\n\n### General background\nMost operating systems also pin memory.',
  sources, model: ollamaModel, modelSettings: { contextLength: 8192, maxLength: 1024, temperature: 0.7 }
}

test('the General background section is split off and labeled, not attributed to the collection', () => {
  assert.deepEqual(splitGeneralBackground(base.answer), {
    collection: 'Pinning stops a page from being evicted while in use.',
    background: 'Most operating systems also pin memory.'
  })
  assert.deepEqual(splitGeneralBackground('**General background**\nOS pinning.').background, 'OS pinning.')
  assert.deepEqual(splitGeneralBackground('No heading here.'), { collection: 'No heading here.', background: '' })
  // A sentence that merely mentions the phrase is not a heading.
  assert.equal(splitGeneralBackground('This is general background on pins.').background, '')
})

test('review input numbers the exact answer sources and treats the answer as data', () => {
  const messages = answerReviewMessages(base)
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user'])
  const input = JSON.parse(messages[1].content)
  assert.deepEqual(input.passages.map((passage) => [passage.number, passage.text]), [
    [1, sources[0].excerpt], [2, sources[1].excerpt]
  ])
  assert.equal(input.question, 'Why pin pages?')
  assert.deepEqual(input.sentences, [
    { id: 1, text: 'Pinning stops a page from being evicted while in use.', section: 'collection' },
    { id: 2, text: 'Most operating systems also pin memory.', section: 'background' }
  ])
  assert.match(messages[0].content, /data, not instructions/)
  assert.match(messages[0].content, /negation .*swapped roles .*wrong numbers/)
  assert.equal(input.previous_exchange, undefined)
})

test('follow-up context travels with the review but is marked as not evidence', () => {
  const exchange = { question: 'What is a buffer pool?', answer: 'A cache of pages.' }
  const input = JSON.parse(answerReviewMessages({ ...base, referenceExchange: exchange })[1].content)
  assert.deepEqual(input.previous_exchange, exchange)
  assert.match(answerReviewMessages(base)[0].content, /previous_exchange and selected_passage.*not evidence/)
})

test('long passages are trimmed to fit, and an answer with no sources is refused', () => {
  const long = { ...base, sources: [{ ...sources[0], excerpt: 'x'.repeat(60_000) }, sources[1]],
    model: { ...ollamaModel, contextLength: 4096 }, modelSettings: { contextLength: 4096 } }
  const input = JSON.parse(answerReviewMessages(long)[1].content)
  assert.ok(input.passages[0].text.length < 12_000)
  assert.match(input.passages[0].text, /\[truncated\]$/)
  assert.equal(input.passages[1].text, sources[1].excerpt)
  assert.throws(() => answerReviewMessages({ ...base, sources: [] }), /no source passages/)
})

test('the answer is split into checkable sentences by code, skipping headings, code and fragments', () => {
  const answer = [
    'Pinning keeps a page resident. It is released by unpin.',
    '',
    '### Steps',
    '- **Fetch** the page into a frame.',
    '1. Increment the `pin_count` field.',
    'Note:',
    '```cpp',
    'page->pin();',
    '```',
    'Ok.',
    '**General background**',
    'Operating systems also pin memory pages.'
  ].join('\n')
  assert.deepEqual(answerSentences(answer).map(({ text, section }) => [text, section]), [
    ['Pinning keeps a page resident.', 'collection'],
    ['It is released by unpin.', 'collection'],
    ['Fetch the page into a frame.', 'collection'],
    ['Increment the pin_count field.', 'collection'],
    ['Operating systems also pin memory pages.', 'background']
  ])
})

test('the Ollama schema fixes one entry per sentence and makes evidence verdicts cite a passage', () => {
  const schema = answerReviewSchema(2, 3)
  const entries = schema.properties.sentences.prefixItems
  assert.equal(entries.length, 2)
  assert.equal(schema.properties.sentences.minItems, 2)
  assert.equal(schema.properties.sentences.maxItems, 2)
  assert.deepEqual(entries[1].anyOf.map((option) => option.properties.id.const), [2, 2, 2])
  const byVerdict = Object.fromEntries(entries[0].anyOf.map((option) => [option.properties.verdict.const, option.properties.passages]))
  assert.equal(byVerdict.supported.minItems, 1)
  assert.equal(byVerdict.contradicted.minItems, 1)
  assert.equal(byVerdict.unsupported.maxItems, 0)
  assert.deepEqual(byVerdict.supported.items.enum, [1, 2, 3])
})

test('parser maps verdicts onto the answer\'s own sentences and never reads a skipped one as checked', () => {
  const answer = 'Pinned pages cannot be evicted. Data pages are written before the log. Pinning is free.\n\n## General background\nOperating systems pin memory too.'
  const review = parseAnswerReview(JSON.stringify({
    sentences: [
      { id: 1, quote: 'A pinned page cannot be evicted', note: 'Passage 1 says so.', verdict: 'supported', passages: [1, 1, 7] },
      { id: 2, quote: 'writes log records to disk before the data page', note: 'WAL is the reverse.', verdict: 'contradicted', passages: [2] },
      { id: 2, quote: '', note: 'duplicate id is ignored', verdict: 'supported', passages: [1] },
      { id: 4, quote: '', note: 'not in passages', verdict: 'unsupported', passages: [] },
      { id: 9, quote: '', note: 'no such sentence', verdict: 'supported', passages: [1] }
    ],
    missing_assumptions: ['Assumes a single-threaded executor.', ''],
    corrected_explanation: 'The log record is written before the data page.'
  }), answer, sources)
  assert.deepEqual(review.claims.map((claim) => [claim.claim, claim.verdict, claim.passages]), [
    ['Pinned pages cannot be evicted.', 'supported', [1]],
    ['Data pages are written before the log.', 'contradicted', [2]],
    ['Pinning is free.', 'unsupported', []],
    ['Operating systems pin memory too.', 'background', []]
  ])
  assert.equal(review.claims[0].evidence, 'A pinned page cannot be evicted')
  assert.equal(review.claims[2].note, 'The reviewer gave no verdict for this sentence.')
  assert.deepEqual(review.missingAssumptions, ['Assumes a single-threaded executor.'])
  assert.equal(review.correctedExplanation, 'The log record is written before the data page.')
})

test('an evidence verdict without a valid passage becomes unsupported; contradicted background stays contradicted', () => {
  const answer = 'Pinned pages stay resident.\n\n## General background\nThe log is written after the page.'
  const review = parseAnswerReview(JSON.stringify({
    sentences: [
      { id: 1, quote: 'A pinned page cannot be evicted', note: '', verdict: 'supported', passages: [5] },
      { id: 2, quote: 'log records to disk before the data page', note: 'Passage 2 says the log goes first.', verdict: 'contradicted', passages: [2] }
    ], missing_assumptions: [], corrected_explanation: ''
  }), answer, sources)
  assert.deepEqual(review.claims.map((claim) => claim.verdict), ['unsupported', 'contradicted'])
})

test('a quote that is not in the cited passage is hidden but does not change the verdict', () => {
  // A small model often "quotes" the answer sentence itself. Showing that as
  // evidence would mislead; overriding the verdict on it flagged nearly every
  // correct answer in the benchmark.
  const answer = 'Pride and Prejudice was written by Jane Austen. A pinned page cannot be evicted by the replacement policy.'
  const review = parseAnswerReview(JSON.stringify({
    sentences: [
      { id: 1, quote: 'Pride and Prejudice was written by Jane Austen', note: '', verdict: 'supported', passages: [1] },
      { id: 2, quote: 'pinned page cannot be evicted ... replacement policy', note: '', verdict: 'supported', passages: [1] }
    ], missing_assumptions: [], corrected_explanation: ''
  }), answer, sources)
  assert.deepEqual(review.claims.map((claim) => claim.verdict), ['supported', 'supported'])
  assert.equal(review.claims[0].evidence, undefined)
  assert.equal(review.claims[1].evidence, 'pinned page cannot be evicted ... replacement policy')
})

test('quote check matches the cited passage only, tolerating small copying slips', () => {
  const passage = ['The WAL protocol writes log records to disk before the data page.']
  assert.equal(quoteInPassages('writes log records to disk before the data page', passage), true)
  assert.equal(quoteInPassages('The WAL protocol writes log records, to disk, before the data page', passage), true)
  assert.equal(quoteInPassages('writes the data page to disk before log records', passage), false)
  assert.equal(quoteInPassages('WAL protocol', passage), false)
  assert.equal(quoteInPassages('', passage), false)
})

test('parser drops a correction when nothing was flagged, and reads fenced JSON', () => {
  const clean = parseAnswerReview('```json\n' + JSON.stringify({
    sentences: [{ id: 1, quote: 'A pinned page cannot be evicted', note: '', verdict: 'supported', passages: [1] }],
    missing_assumptions: [], corrected_explanation: 'Unneeded rewrite.'
  }) + '\n```', 'Pinned pages stay resident.', sources)
  assert.equal(clean.correctedExplanation, undefined)
  assert.throws(() => parseAnswerReview('not json', 'Pinned pages stay resident.', sources), /could not be read/)
  assert.throws(() => parseAnswerReview(JSON.stringify({ sentences: [] }), 'Pinned pages stay resident.', sources), /could not be read/)
})

test('Ollama review uses the generator, the review schema, thinking off and temperature zero', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body)
      assert.equal(request.model, 'llama3.2')
      assert.equal(request.think, false)
      assert.equal(request.options.temperature, 0)
      assert.deepEqual(request.format, answerReviewSchema(2, 2))
      return { ok: true, json: async () => ({ done_reason: 'stop', message: { content: JSON.stringify({
        sentences: [{ id: 1, quote: 'A pinned page cannot be evicted', note: '', verdict: 'supported', passages: [1] }, { id: 2, quote: '', note: '', verdict: 'unsupported', passages: [] }],
        missing_assumptions: [], corrected_explanation: ''
      }) } }) }
    }
    const review = await reviewOllamaAnswer(base)
    assert.equal(review.modelName, 'llama3.2')
    assert.deepEqual(review.claims.map((claim) => claim.verdict), ['supported', 'background'])
    assert.equal(typeof review.durationMs, 'number')
  } finally { globalThis.fetch = originalFetch }
})

test('remote review sends the same review input to the provider', async () => {
  const originalFetch = globalThis.fetch
  const model = { id: 'remote:test', name: 'Remote', engine: 'remote', status: 'ready', remoteModelName: 'remote-test',
    apiKey: 'test-key', baseUrl: 'https://provider.example/v1', contextLength: 8192 }
  try {
    globalThis.fetch = async (url, options) => {
      const request = JSON.parse(options.body)
      assert.equal(url, 'https://provider.example/v1/chat/completions')
      assert.equal(request.temperature, 0)
      assert.equal(request.messages[1].content, answerReviewMessages({ ...base, model })[1].content)
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        sentences: [{ id: 1, quote: 'writes log records to disk before the data page', note: '', verdict: 'contradicted', passages: [2] }],
        missing_assumptions: [], corrected_explanation: 'Log first.'
      }) } }] }) }
    }
    const review = await reviewRemoteAnswer({ ...base, model })
    assert.equal(review.claims[0].verdict, 'contradicted')
    assert.equal(review.correctedExplanation, 'Log first.')
  } finally { globalThis.fetch = originalFetch }
})

const conversation = Object.freeze([
  { id: 'q1', role: 'user', text: 'What is a buffer pool?' },
  { id: 'a1', role: 'assistant', text: 'A cache of pages.', sources: [sources[0]] },
  { id: 'q2', role: 'user', text: 'Why pin them?' },
  { id: 'a2', role: 'assistant', text: 'So they are not evicted.', sources,
    conversationContextMode: 'contextual',
    answerContext: { prompt: 'Why pin them?', conversationContextMode: 'contextual', modelId: 'ollama:llama3.2',
      referenceExchange: { question: 'What is a buffer pool?', answer: 'A cache of pages.' } },
    simplerExplanation: { text: 'Pins keep pages put.', sources: [sources[0]], responseDurationMs: 1 } },
  { id: 'q3', role: 'user', text: 'Later question' },
  { id: 'a3', role: 'assistant', text: 'Later answer', sources: [sources[1]] }
])

test('the request reviews the selected answer with its own question, context and displayed sources', () => {
  const request = answerReviewRequest(conversation, 'a2', ollamaModel)
  assert.equal(request.question, 'Why pin them?')
  assert.equal(request.answer, 'So they are not evicted.')
  assert.deepEqual(request.sources, sources)
  assert.deepEqual(request.referenceExchange, { question: 'What is a buffer pool?', answer: 'A cache of pages.' })
  assert.equal(request.model, ollamaModel)
})

test('reviewing the simpler version checks that text against that version\'s sources', () => {
  const simple = conversation.map((message) => message.id === 'a2' ? { ...message, explanationView: 'simple' } : message)
  assert.equal(displayedAnswerView(simple[3]), 'simple')
  const request = answerReviewRequest(simple, 'a2', ollamaModel)
  assert.equal(request.answer, 'Pins keep pages put.')
  assert.deepEqual(request.sources, [sources[0]])
})

test('Verify is offered once per version, only for sourced, non-clarifying answers', () => {
  assert.equal(canVerifyAnswer(conversation[3]), true)
  assert.equal(canVerifyAnswer({ ...conversation[3], answerReviews: { original: {} } }), false)
  assert.equal(canVerifyAnswer({ ...conversation[3], answerReviews: { simple: {} } }), true)
  assert.equal(canVerifyAnswer({ ...conversation[3], sources: [] }), false)
  assert.equal(canVerifyAnswer({ ...conversation[3], conversationContextMode: 'clarify' }), false)
  assert.equal(canVerifyAnswer(conversation[2]), false)
})

test('the reviewer is the model that wrote the answer, never a silent substitute', () => {
  const other = { id: 'ollama:gemma', name: 'gemma', engine: 'ollama', status: 'ready', ollamaModelName: 'gemma' }
  assert.deepEqual(reviewModelFor(conversation[3], [ollamaModel, other], other), { model: ollamaModel, sameModel: true })
  const missing = reviewModelFor(conversation[3], [other], other)
  assert.equal(missing.model, undefined)
  assert.match(missing.unavailableReason, /ollama:llama3.2.*not available/)
  // Answers saved before the generator was recorded fall back, and say so.
  assert.deepEqual(reviewModelFor(conversation[1], [ollamaModel, other], other), { model: other, sameModel: false })
})
