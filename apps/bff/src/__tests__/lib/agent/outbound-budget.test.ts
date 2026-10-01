import { afterEach, expect, it } from 'bun:test'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

const { config } = await import('../../../config')
const { AgentRequestBudgetError, guardedAgentFetch } = await import(
  '../../../lib/agent/outbound-budget'
)
const operator = config.operator

afterEach(() => {
  config.operator = operator
})

it('未知流式或 multipart body 不缓冲、不派发，并保留本地诊断', async () => {
  let dispatches = 0
  const rejected: string[] = []
  const fetch = guardedAgentFetch(
    async () => {
      dispatches += 1
      return new Response()
    },
    {
      onRejected: async (error) => {
        rejected.push(error.reason)
      },
    },
  )
  const stream = new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
  const multipart = new FormData()
  multipart.append('image', 'private-image-bytes')
  for (const body of [stream, multipart]) {
    await expect(fetch('http://gateway.test', { method: 'POST', body })).rejects.toBeInstanceOf(
      AgentRequestBudgetError,
    )
  }
  const request = new Request('http://gateway.test', {
    method: 'POST',
    body: 'private-serialized-body',
  })
  await expect(fetch(request)).rejects.toBeInstanceOf(AgentRequestBudgetError)
  expect(request.bodyUsed).toBe(false)
  expect(dispatches).toBe(0)
  expect(rejected).toEqual(['unsupported_body', 'unsupported_body', 'unsupported_body'])
})

it('已序列化多字节 body 在真实字节边界放行，非法配额拒发', async () => {
  let dispatches = 0
  const sizes: number[] = []
  const transport = async () => {
    dispatches += 1
    return new Response()
  }
  const setLimit = (limit: number) => {
    config.operator = {
      ...operator,
      quotas: { ...operator.quotas, 'agent:request-max-bytes': limit },
    }
  }
  setLimit(7)
  await guardedAgentFetch(transport, {
    onDispatch: async (size) => {
      sizes.push(size)
    },
  })('http://gateway.test', { body: '中🐈' })
  expect(sizes).toEqual([7])
  for (const limit of [6, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    setLimit(limit)
    await expect(
      guardedAgentFetch(transport)('http://gateway.test', { body: '中🐈' }),
    ).rejects.toBeInstanceOf(AgentRequestBudgetError)
  }
  expect(dispatches).toBe(1)
})

it('does not record an already cancelled request as dispatched', async () => {
  const signal = AbortSignal.abort()
  let calls = 0
  let recorded = 0
  const fetch = guardedAgentFetch(
    async () => {
      calls++
      return new Response()
    },
    {
      onDispatch: async () => {
        recorded++
      },
    },
  )
  await expect(fetch('http://gateway.test', { body: '{}', signal })).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(calls).toBe(0)
  expect(recorded).toBe(0)
})
