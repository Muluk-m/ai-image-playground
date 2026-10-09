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
