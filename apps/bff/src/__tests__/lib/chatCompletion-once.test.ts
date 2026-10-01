import { afterEach, expect, it } from 'bun:test'
import type { ChatAttempt } from '../../lib/chatCompletion'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.OPERATOR_CONFIG_FILE = ''
process.env.LOG_LEVEL = 'silent'
const { askChatModelOnce, setChatFetchForTesting } = await import('../../lib/chatCompletion')
const { config } = await import('../../config')
const operator = config.operator
const ASK = {
  attemptId: 'analysis-task:attempt-1',
  model: 'fixture-analysis',
  prompt: 'Inspect the image',
  maxTokens: 64,
  timeoutMs: 1000,
}
afterEach(() => {
  setChatFetchForTesting()
  config.operator = operator
})

it('dispatches a failed independent analysis exactly once and records unknown usage', async () => {
  let calls = 0
  const attempts: ChatAttempt[] = []
  setChatFetchForTesting(async () => {
    calls++
    return new Response('unavailable', { status: 502 })
  })
  await expect(
    askChatModelOnce({
      ...ASK,
      onAttempt: async (attempt) => {
        attempts.push(attempt)
      },
    }),
  ).rejects.toMatchObject({ status: 502 })
  expect(calls).toBe(1)
  expect(attempts).toMatchObject([
    { id: ASK.attemptId, httpDispatchCount: 1, usage: null, status: 'failed' },
  ])
})

it('preserves cached, explicit zero and missing usage without retrying unstructured output', async () => {
  const attempts: ChatAttempt[] = []
  const usage = [
    { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
    { prompt_tokens: 0, completion_tokens: 0 },
    undefined,
  ]
  let calls = 0
  setChatFetchForTesting(async () =>
    Response.json({ choices: [{ message: { content: 'plain answer' } }], usage: usage[calls++] }),
  )
  for (let index = 0; index < 3; index++) {
    expect(
      await askChatModelOnce({
        ...ASK,
        attemptId: `attempt-${index}`,
        onAttempt: async (attempt) => {
          attempts.push(attempt)
        },
      }),
    ).toBe('plain answer')
  }
  expect(calls).toBe(3)
  expect(attempts.map((attempt) => attempt.usage)).toEqual([
    { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    { inputTokens: 0, outputTokens: 0 },
    null,
  ])
})

it('rejects the final serialized body before committing a dispatch', async () => {
  config.operator = { ...operator, quotas: { ...operator.quotas, 'agent:request-max-bytes': 1 } }
  let calls = 0
  let intents = 0
  const attempts: ChatAttempt[] = []
  setChatFetchForTesting(async () => {
    calls++
    return new Response()
  })
  await expect(
    askChatModelOnce({
      ...ASK,
      beforeDispatch: async () => {
        intents++
      },
      onAttempt: async (attempt) => {
        attempts.push(attempt)
      },
    }),
  ).rejects.toMatchObject({ name: 'AgentRequestBudgetError' })
  expect(calls).toBe(0)
  expect(intents).toBe(0)
  expect(attempts).toMatchObject([
    { id: ASK.attemptId, httpDispatchCount: 0, usage: { inputTokens: 0, outputTokens: 0 } },
  ])
})

it('cancels during the durable intent write without sending and reports a known zero attempt', async () => {
  const controller = new AbortController()
  let calls = 0
  const attempts: ChatAttempt[] = []
  const intents: { id: string; requestBytes: number }[] = []
  setChatFetchForTesting(async () => {
    calls++
    return new Response()
  })
  await expect(
    askChatModelOnce({
      ...ASK,
      signal: controller.signal,
      beforeDispatch: async (intent) => {
        intents.push(intent)
        controller.abort()
      },
      onAttempt: async (attempt) => {
        attempts.push(attempt)
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls).toBe(0)
  expect(intents).toMatchObject([{ id: ASK.attemptId }])
  expect(intents[0]?.requestBytes).toBeGreaterThan(0)
  expect(attempts).toMatchObject([
    { id: ASK.attemptId, httpDispatchCount: 0, usage: { inputTokens: 0, outputTokens: 0 } },
  ])
})

it('propagates cancellation after dispatch and retains unknown usage', async () => {
  const controller = new AbortController()
  const attempts: ChatAttempt[] = []
  let calls = 0
  setChatFetchForTesting(async (_input, init) => {
    calls++
    controller.abort()
    init?.signal?.throwIfAborted()
    throw new Error('external cancellation did not reach transport')
  })
  await expect(
    askChatModelOnce({
      ...ASK,
      signal: controller.signal,
      onAttempt: async (attempt) => {
        attempts.push(attempt)
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls).toBe(1)
  expect(attempts).toMatchObject([{ httpDispatchCount: 1, usage: null }])
})

it('retains the upstream request identifier when a response body fails after headers', async () => {
  const attempts: ChatAttempt[] = []
  setChatFetchForTesting(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('fixture response disconnected'))
          },
        }),
        { headers: { 'x-request-id': 'request-accepted-42' } },
      ),
  )
  await expect(
    askChatModelOnce({
      ...ASK,
      onAttempt: async (attempt) => {
        attempts.push(attempt)
      },
    }),
  ).rejects.toThrow('fixture response disconnected')
  expect(attempts).toMatchObject([
    { upstreamRequestId: 'request-accepted-42', httpDispatchCount: 1, usage: null },
  ])
})
