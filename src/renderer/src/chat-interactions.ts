import type { AnswerView, ApplicationSettings, ChatMessage, ChatSelectedPassage, LocalModel, ModelRuntimeSettings } from '@shared/app-state'
import type { EngineAnswerReviewRequest, EngineChatRequest } from '@shared/engine'
import { answerForDisplay, lastChatExchange } from '../../shared/study-chat-pipeline'
import { answerModel } from '../../shared/chat-model-selection'
import { answerReasoningSettings } from '../../shared/reasoning'

export interface ChatDraft {
  text: string
  selectedPassage?: ChatSelectedPassage
}

// Use the selected answer's own question and context, never the latest chat turn.
export function questionForAnswer(messages: ChatMessage[], answerId: string): ChatMessage | undefined {
  const answerIndex = messages.findIndex((message) => message.id === answerId && message.role === 'assistant')
  if (answerIndex < 0) return undefined
  return messages.slice(0, answerIndex).reverse().find((message) => message.role === 'user')
}

export function canExplainSimpler(message: ChatMessage): boolean {
  return message.role === 'assistant' && Boolean(message.text.trim()) &&
    Boolean(message.sources?.length) && message.conversationContextMode !== 'clarify' &&
    message.explanationDepth !== 'simple'
}

export function canRetryWithReasoning(message: ChatMessage, model?: LocalModel): boolean {
  return message.role === 'assistant' && Boolean(message.text.trim()) &&
    message.conversationContextMode !== 'clarify' &&
    Boolean(message.answerContext) && !message.reasoningAnswer &&
    message.reasoning?.used === false && message.reasoning.supported === true &&
    model?.engine === 'ollama' && model.status === 'ready' && model.id === message.reasoning.modelId
}

export function reasoningRetryRequest(
  messages: ChatMessage[], answerId: string,
  context: Pick<EngineChatRequest, 'model' | 'materials' | 'settings' | 'modelSettings'>
): EngineChatRequest | undefined {
  const answerIndex = messages.findIndex(message => message.id === answerId)
  const answer = messages[answerIndex]
  const question = questionForAnswer(messages, answerId)
  if (!answer || !question || !canRetryWithReasoning(answer, context.model)) return undefined
  const saved = answer.answerContext!
  const modelSettings = saved.modelSettings ?? context.modelSettings
  if (!modelSettings) return undefined
  // Re-answer the same task with its saved evidence, not the old answer or later turns.
  return {
    ...context, ...saved,
    messages: messages.slice(0, messages.findIndex(message => message.id === question.id)),
    retrievedSources: answer.sources ?? [],
    reasoning: true,
    modelSettings: answerReasoningSettings({ ...modelSettings, reasoningMode: 'on' }, true),
    applicationSettings: { ...(saved.applicationSettings ?? context.settings.application),
      suggestionMode: context.settings.application.suggestionMode,
      followUpSuggestionCount: context.settings.application.followUpSuggestionCount }
  }
}

export function simplerExplanationSettings(settings: ApplicationSettings): ApplicationSettings {
  return { ...settings, explanationDepthEnabled: true, explanationDepth: 'simple',
    suggestionMode: 'off', followUpSuggestionCount: 0 }
}

export function simplerExplanationRequest(
  messages: ChatMessage[], answerId: string,
  context: Pick<EngineChatRequest, 'model' | 'materials' | 'settings' | 'modelSettings'>
): EngineChatRequest | undefined {
  const answerIndex = messages.findIndex(message => message.id === answerId)
  const answer = messages[answerIndex]
  const question = questionForAnswer(messages, answerId)
  if (!answer || !question || !canExplainSimpler(answer) || answer.simplerExplanation) return undefined
  const questionIndex = messages.findIndex(message => message.id === question.id)
  // Older conversations have no saved request metadata. Recover only the exchange
  // preceding this question; a later exchange may be about something else entirely.
  const previous = answer.conversationContextMode !== 'standalone'
    ? lastChatExchange(messages.slice(0, questionIndex)) : undefined
  const saved = answer.answerContext ?? {
    prompt: question.text,
    conversationContextMode: previous ? 'contextual' as const : 'standalone' as const,
    referenceExchange: previous
  }
  return {
    ...context, selectedPassage: question.selectedPassage, ...saved, messages: messages.slice(0, answerIndex),
    answerToSimplify: answer.text,
    retrievedSources: answer.sources,
    modelSettings: context.modelSettings,
    applicationSettings: simplerExplanationSettings(context.settings.application)
  }
}

// The answer version the student is looking at; each version gets its own review.
export function displayedAnswerView(message: ChatMessage): AnswerView {
  if (message.explanationView === 'reasoning' && message.reasoningAnswer) return 'reasoning'
  if (message.explanationView === 'simple' && message.simplerExplanation) return 'simple'
  return 'original'
}

export function canVerifyAnswer(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.conversationContextMode === 'clarify') return false
  const displayed = answerForDisplay(message)
  return Boolean(displayed.text.trim()) && Boolean(displayed.sources?.length) &&
    !message.answerReviews?.[displayedAnswerView(message)]
}

export interface ReviewModelChoice {
  model?: LocalModel
  // True when the reviewer is known to be the model that wrote the answer.
  sameModel: boolean
  unavailableReason?: string
}

// Verify answer reuses the generator. Answers saved before the generator was
// recorded fall back to the chat's current model, and say so.
export function reviewModelFor(message: ChatMessage, models: LocalModel[], chatModel?: LocalModel): ReviewModelChoice {
  // A simpler or reasoning version may have been written by a later model.
  const generatorId = answerForDisplay(message).reasoning?.modelId ?? message.answerContext?.modelId
  if (!generatorId) {
    return chatModel?.status === 'ready' ? { model: chatModel, sameModel: false }
      : { sameModel: false, unavailableReason: 'Select a ready chat model to verify this answer.' }
  }
  const generator = answerModel(models, generatorId)
  if (generator?.status === 'ready') return { model: generator, sameModel: true }
  return { sameModel: false, unavailableReason: `The model that wrote this answer (${generator?.name ?? generatorId}) is not available.` }
}

export function answerReviewRequest(
  messages: ChatMessage[], answerId: string, model: LocalModel, modelSettings?: ModelRuntimeSettings
): EngineAnswerReviewRequest | undefined {
  const answerIndex = messages.findIndex(message => message.id === answerId)
  const answer = messages[answerIndex]
  const question = questionForAnswer(messages, answerId)
  if (!answer || !question || !canVerifyAnswer(answer)) return undefined
  const displayed = answerForDisplay(answer)
  const saved = answer.answerContext
  const selectedPassage = saved?.selectedPassage ?? question.selectedPassage
  // Same recovery as Explain more simply for answers saved without context.
  const referenceExchange = saved
    ? (saved.conversationContextMode === 'contextual' ? saved.referenceExchange : undefined)
    : answer.conversationContextMode !== 'standalone'
      ? lastChatExchange(messages.slice(0, messages.findIndex(message => message.id === question.id))) : undefined
  return {
    question: saved?.prompt ?? question.text,
    ...(selectedPassage ? { selectedPassage } : {}),
    ...(referenceExchange ? { referenceExchange } : {}),
    answer: displayed.text,
    sources: displayed.sources ?? [],
    model,
    modelSettings: modelSettings ?? saved?.modelSettings
  }
}

// Editing keeps the question's identity but invalidates all answers after it.
export function replaceQuestion(messages: ChatMessage[], messageId: string, text: string, selectedPassage?: ChatSelectedPassage): ChatMessage[] | undefined {
  const index = messages.findIndex((message) => message.id === messageId && message.role === 'user')
  if (index < 0 || !text.trim()) return undefined
  return [...messages.slice(0, index), { id: messageId, role: 'user', text: text.trim(), ...(selectedPassage ? { selectedPassage } : {}) }]
}
