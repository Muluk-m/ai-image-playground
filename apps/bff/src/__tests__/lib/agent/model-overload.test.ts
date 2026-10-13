import { afterEach, expect, it } from 'bun:test'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { completionStream, controlledCompletion } from '../../helpers/agentStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
const { agentModel, agentStreamFn, setAgentFetchForTesting, setAgentRetryBackoffForTesting } =
  await import('../../../lib/agent/model')
setAgentRetryBackoffForTesting(0)
afterEach(() => setAgentFetchForTesting())
const context = { messages: [{ role: 'user' as const, content: '换背景', timestamp: 1 }] }
const overloaded = () =>
  Response.json(
    { error: { message: 'Our servers are currently overloaded. Please try again later.' } },
    { status: 503 },
  )

it('retries overload before output and emits only the successful response', async () => {
  let calls = 0,
    dispatches = 0,
    retries = 0
  setAgentFetchForTesting(async () => (++calls === 1 ? overloaded() : completionStream('完成')))
  const stream = await agentStreamFn(undefined, {
    onDispatch: async () => {
      dispatches++
    },
    onRetry: async (message) => {
      retries++
      expect(message.stopReason).toBe('error')
    },
  })(agentModel(), context)
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  expect(calls).toBe(2)
  expect(dispatches).toBe(2)
  expect(retries).toBe(1)
  expect(events.filter((event) => event.type === 'start')).toHaveLength(1)
  expect(events.some((event) => event.type === 'error')).toBe(false)
  expect((await stream.result()).content).toEqual([{ type: 'text', text: '完成' }])
})

it('bounds persistent overload to three attempts and keeps the original error', async () => {
  let calls = 0
  setAgentFetchForTesting(async () => {
    calls++
    return overloaded()
  })
  const stream = await agentStreamFn()(agentModel(), context)
  const result = await stream.result()
  expect(calls).toBe(3)
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('Our servers are currently overloaded')
})

it('does not retry authentication failures or ambiguous network failures', async () => {
  for (const transport of [
    async () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }),
    async () => {
      throw new Error('connection reset')
    },
    async () => {
      throw new Error('Our servers are currently overloaded. Connection closed after dispatch.')
    },
    async () => Response.json({ error: { message: 'overloaded' } }, { status: 401 }),
  ]) {
    let calls = 0
    setAgentFetchForTesting(async () => {
      calls++
      return transport()
    })
    expect((await (await agentStreamFn()(agentModel(), context)).result()).stopReason).toBe('error')
    expect(calls).toBe(1)
  }
})

it('does not retry an HTTP 200 stream failure before content without rejection evidence', async () => {
  let calls = 0
  const upstream = controlledCompletion()
  setAgentFetchForTesting(async () => {
    calls++
    setTimeout(() => upstream.fail('Our servers are currently overloaded.'), 1)
    return upstream.responseFor()
  })
  const stream = await agentStreamFn()(agentModel(), context)
  expect((await stream.result()).stopReason).toBe('error')
  expect(calls).toBe(1)
})

it('does not retry after text or tool output even if the stream fails with an overload message', async () => {
  for (const tool of [false, true]) {
    let calls = 0
    const upstream = controlledCompletion()
    if (tool)
      upstream.pushToolCall(0, { id: 'tool-1', name: 'editImage', args: { prompt: '换背景' } })
    else upstream.push('开始处理')
    setAgentFetchForTesting(async () => {
      calls++
      return upstream.responseFor()
    })
    const stream = await agentStreamFn()(agentModel(), context)
    for await (const event of stream) {
      if (event.type === (tool ? 'toolcall_delta' : 'text_delta')) {
        upstream.fail('Our servers are currently overloaded.')
        break
      }
    }
    expect((await stream.result()).stopReason).toBe('error')
    expect(calls).toBe(1)
  }
})

it('honors cancellation during overload backoff without another dispatch', async () => {
  let calls = 0
  const controller = new AbortController()
  setAgentFetchForTesting(async () => {
    calls++
    return overloaded()
  })
  const stream = await agentStreamFn(undefined, { onRetry: async () => controller.abort() })(
    agentModel(),
    context,
    { signal: controller.signal },
  )
  expect((await stream.result()).stopReason).toBe('aborted')
  expect(calls).toBe(1)
})

function wireError(error: Record<string, string>, prefix = '') {
  const bytes = new TextEncoder().encode(`${prefix}data: ${JSON.stringify({ error })}\n\n`)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // 包含跨网络数据块的 SSE 帧。
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

it('recovers HTTP 200 SSE overload errors and gateway overload status variants', async () => {
  for (const failure of [
    () => wireError({ message: 'Our servers are currently overloaded. Please try again later.' }),
    () => wireError({ type: 'overloaded_error', message: 'Please try again later.' }),
    () =>
      wireError(
        { code: 'server_overloaded', message: 'Busy' },
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      ),
    () => Response.json({ error: { type: 'overloaded_error', message: 'Busy' } }, { status: 500 }),
    () => Response.json({ error: { message: 'Overloaded' } }, { status: 502 }),
    () => Response.json({ error: { message: 'overloaded' } }, { status: 429 }),
    () => new Response('Service Unavailable', { status: 503 }),
    () => new Response('', { status: 529 }),
  ]) {
    let calls = 0
    setAgentFetchForTesting(async () => (++calls === 1 ? failure() : completionStream('完成')))
    const stream = await agentStreamFn()(agentModel(), context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)
    expect((await stream.result()).stopReason).toBe('stop')
    expect(calls).toBe(2)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'start')).toHaveLength(1)
  }
})

it('does not retry non-overload responses or explicit SSE overload after output', async () => {
  for (const failure of [
    () => wireError({ code: 'invalid_api_key', message: 'Authentication failed' }),
    () => Response.json({ error: { message: 'Insufficient quota' } }, { status: 429 }),
    () => Response.json({ error: { message: 'Internal server error' } }, { status: 500 }),
    ...[
      { content: '已经开始' },
      { reasoning_content: '思考中' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'tool-1',
            type: 'function',
            function: { name: 'editImage', arguments: '{}' },
          },
        ],
      },
    ].map(
      (delta) => () =>
        wireError(
          { type: 'overloaded_error', message: 'Overloaded' },
          `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
        ),
    ),
  ]) {
    let calls = 0
    setAgentFetchForTesting(async () => {
      calls++
      return failure()
    })
    const result = await (await agentStreamFn()(agentModel(), context)).result()
    expect(result.stopReason).toBe('error')
    expect(calls).toBe(1)
  }
})

it('bounds SSE overload retries and does not reuse rejection evidence for a later network error', async () => {
  for (const networkFailure of [false, true]) {
    let calls = 0
    setAgentFetchForTesting(async () => {
      calls++
      if (networkFailure && calls > 1) throw new Error('overloaded connection reset')
      return wireError({ code: 'server_overloaded', message: 'Overloaded' })
    })
    const stream = await agentStreamFn()(agentModel(), context)
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) events.push(event)
    expect((await stream.result()).stopReason).toBe('error')
    expect(calls).toBe(networkFailure ? 2 : 3)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
  }
})
