import { afterEach, expect, it } from 'bun:test'
import { providerFetch } from '../../../lib/agent/provider-fetch'
import { _setSafeFetchForTesting } from '../../../lib/safeFetch'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
const { AgentRequestBudgetError, guardedAgentFetch } = await import(
  '../../../lib/agent/outbound-budget'
)

afterEach(() => _setSafeFetchForTesting())

it('preserves Request properties and rejects inherited stream bodies before dispatch', async () => {
  _setSafeFetchForTesting({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] })
  let dispatched = 0
  let rejected = 0
  let options: RequestInit | undefined
  const fetch = providerFetch(
    guardedAgentFetch(
      async (_input, init) => {
        options = init
        return new Response('ok')
      },
      {
        onDispatch: async () => {
          dispatched++
        },
        onRejected: async () => {
          rejected++
        },
      },
    ),
    'https://provider.example',
  )
  const controller = new AbortController()
  const request = new Request('https://provider.example/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture' },
    body: '{}',
    signal: controller.signal,
  })
  await expect(fetch(request)).rejects.toBeInstanceOf(AgentRequestBudgetError)
  await expect(fetch(request, { body: undefined })).rejects.toBeInstanceOf(AgentRequestBudgetError)
  expect(dispatched).toBe(0)
  expect(rejected).toBe(2)
  await fetch(request, { body: '{"replacement":true}' })
  expect(dispatched).toBe(1)
  expect(options?.method).toBe('POST')
  expect(options?.body).toBe('{"replacement":true}')
  expect(new Headers(options?.headers).get('authorization')).toBe('Bearer fixture')
  expect(options?.signal).toBe(request.signal)
  controller.abort()
  await expect(fetch(request, { body: '{}' })).rejects.toThrow()
  expect(dispatched).toBe(1)
})

it('pins a public DNS result and preserves the authenticated host and TLS name', async () => {
  _setSafeFetchForTesting({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] })
  let target: string | undefined
  let options: (RequestInit & { tls?: { serverName: string } }) | undefined
  const fetch = providerFetch(async (input, init) => {
    target = String(input)
    options = init
    return new Response('ok')
  }, 'https://provider.example/v1')
  await fetch('https://provider.example/v1/messages', {
    method: 'POST',
    body: '{}',
    headers: { 'x-api-key': 'fixture' },
  })
  expect(target).toBe('https://8.8.8.8/v1/messages')
  expect(new Headers(options?.headers).get('host')).toBe('provider.example')
  expect(new Headers(options?.headers).get('x-api-key')).toBe('fixture')
  expect(options?.tls?.serverName).toBe('provider.example')
  expect(options?.redirect).toBe('manual')
})

it('rejects private DNS results and alternate origins before dispatching credentials', async () => {
  _setSafeFetchForTesting({
    resolve: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  })
  let calls = 0
  const fetch = providerFetch(async () => {
    calls++
    return new Response('unexpected')
  }, 'https://provider.example')
  await expect(fetch('https://provider.example/messages')).rejects.toThrow('指向内网')
  await expect(fetch('https://other.example/messages')).rejects.toThrow('与配置不一致')
  expect(calls).toBe(0)
})

it('does not follow an upstream redirect to any other target', async () => {
  _setSafeFetchForTesting({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] })
  let calls = 0
  const fetch = providerFetch(async () => {
    calls++
    return new Response(null, {
      status: 307,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    })
  }, 'https://provider.example')
  await expect(fetch('https://provider.example/messages')).rejects.toThrow('不允许重定向')
  expect(calls).toBe(1)
})
