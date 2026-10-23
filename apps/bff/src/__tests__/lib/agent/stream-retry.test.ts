import { expect, it } from 'bun:test'
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { retryOverloadedStream } from '../../../lib/agent/stream-retry'

const model = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions' as const,
  provider: 'test',
  baseUrl: 'https://gateway.test/v1',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
}
const context = { messages: [] }
const rejected: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 1,
  stopReason: 'error',
  errorMessage: 'Our servers are currently overloaded.',
  usage: {
    input: 42,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 42,
    cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
  },
}

it('does not copy already recorded usage into a cancelled attempt during backoff', async () => {
  const controller = new AbortController()
  let calls = 0
  const recorded: AssistantMessage[] = []
  const stream = await retryOverloadedStream(
    () => {
      calls++
      const result = createAssistantMessageEventStream()
      result.push({ type: 'error', reason: 'error', error: rejected })
      result.end(rejected)
      return result
    },
    () => true,
    async (message) => {
      recorded.push(message)
      setTimeout(() => controller.abort(), 1)
    },
    1000,
  )(model, context, { signal: controller.signal })
  const message = await stream.result()
  expect(calls).toBe(1)
  expect(recorded).toHaveLength(1)
  expect(recorded[0]!.usage.input).toBe(42)
  expect(message.stopReason).toBe('aborted')
  expect(message.usage.totalTokens).toBe(0)
  expect(message.usage.cost.total).toBe(0)
})

function failed(message: AssistantMessage) {
  const result = createAssistantMessageEventStream()
  result.push({ type: 'error', reason: 'error', error: message })
  result.end(message)
  return result
}

function stopped(id: string): AssistantMessage {
  return { ...rejected, model: id, stopReason: 'stop', errorMessage: undefined }
}

it('switches once to the fallback model and retries that model with its own effort', async () => {
  const fallbackModel = { ...model, id: 'fallback-model' }
  const seen: { id: string; reasoning?: string }[] = []
  const next: string[] = []
  let fallbackCalls = 0
  const stream = await retryOverloadedStream(
    (active, _context, options) => {
      seen.push({ id: active.id, reasoning: options?.reasoning })
      return failed({ ...rejected, model: active.id })
    },
    () => true,
    async (_message, nextModelId) => {
      next.push(nextModelId)
    },
    0,
    {
      model: fallbackModel,
      reasoning: 'low',
      stream: (active, _context, options) => {
        fallbackCalls += 1
        seen.push({ id: active.id, reasoning: options?.reasoning })
        if (fallbackCalls === 1) return failed({ ...rejected, model: active.id })
        const done = stopped(active.id)
        const result = createAssistantMessageEventStream()
        result.end(done)
        return result
      },
    },
  )(model, context, { reasoning: 'high' })
  const message = await stream.result()
  expect(seen).toEqual([
    { id: 'test-model', reasoning: 'high' },
    { id: 'fallback-model', reasoning: 'low' },
    { id: 'fallback-model', reasoning: 'low' },
  ])
  expect(next).toEqual(['fallback-model', 'fallback-model'])
  expect(message.stopReason).toBe('stop')
  expect(message.model).toBe('fallback-model')
})

it('keeps retrying the primary model when the request does not fit the fallback window', async () => {
  const fallbackModel = { ...model, id: 'fallback-model' }
  const seen: string[] = []
  let fallbackCalls = 0
  const stream = await retryOverloadedStream(
    (active) => {
      seen.push(active.id)
      return failed(rejected)
    },
    () => true,
    async () => {},
    0,
    {
      model: fallbackModel,
      reasoning: 'low',
      fits: () => false,
      stream: () => {
        fallbackCalls += 1
        return failed(rejected)
      },
    },
  )(model, context, { reasoning: 'high' })
  const message = await stream.result()
  expect(seen).toEqual(['test-model', 'test-model', 'test-model'])
  expect(fallbackCalls).toBe(0)
  expect(message.stopReason).toBe('error')
  expect(message.model).toBe('test-model')
})

it('does not reuse settled usage when recording the next attempt fails', async () => {
  const stream = await retryOverloadedStream(
    () => {
      const result = createAssistantMessageEventStream()
      result.push({ type: 'error', reason: 'error', error: rejected })
      result.end(rejected)
      return result
    },
    () => true,
    async () => {
      throw new Error('call record failed')
    },
    0,
  )(model, context)
  const message = await stream.result()
  expect(message.errorMessage).toBe('call record failed')
  expect(message.usage.totalTokens).toBe(0)
})
