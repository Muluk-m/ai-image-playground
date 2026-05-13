import { describe, expect, it, vi } from 'vitest'
import { handleProxyRequest } from './handler'
import type { ChannelConfig } from './types'

const bearerChannel: ChannelConfig = {
  id: 'test-openai',
  kind: 'openai-compat',
  label: 'Test',
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer', secretRef: 'OPENAI_API_KEY' },
  models: [{ id: 'm1', label: 'M1' }],
  defaults: { apiMode: 'images', timeout: 600 },
  allowedPaths: ['images/generations', 'images/edits'],
}

const queryKeyChannel: ChannelConfig = {
  id: 'test-gemini',
  kind: 'gemini',
  label: 'Test Gemini',
  baseUrl: 'https://gen.example/v1beta',
  auth: { type: 'query-key', secretRef: 'GEMINI_KEY', queryParam: 'key' },
  models: [{ id: 'g1', label: 'G1' }],
  defaults: { apiMode: 'images', timeout: 600 },
  allowedPaths: ['models/g1:generateContent'],
}

function makeRequest(method: string, url: string, init: RequestInit = {}): Request {
  return new Request(url, { method, ...init })
}

describe('handleProxyRequest validation', () => {
  it('returns 404 when channel is undefined', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/missing/anything'),
      channel: undefined,
      path: 'anything',
      env: {},
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'channel_not_found' })
  })

  it('returns 503 when channel is disabled', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: { ...bearerChannel, disabled: true },
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'channel_disabled' })
  })

  it('returns 501 for http-template kind', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/anything'),
      channel: { ...bearerChannel, kind: 'http-template' },
      path: 'anything',
      env: {},
    })
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: 'kind_not_implemented', kind: 'http-template' })
  })

  it('returns 403 when path is not in allowedPaths', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/chat/completions'),
      channel: bearerChannel,
      path: 'chat/completions',
      env: { OPENAI_API_KEY: 'sk-real' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'path_not_allowed', path: 'chat/completions' })
  })

  it('returns 403 when path contains ..', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/../secret'),
      channel: bearerChannel,
      path: 'images/../secret',
      env: { OPENAI_API_KEY: 'sk-real' },
    })
    expect(res.status).toBe(403)
  })

  it('returns 500 when secret env var is missing', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: {},
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'secret_missing', secretRef: 'OPENAI_API_KEY' })
  })

  it('returns 405 for unsupported methods', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('DELETE', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
    })
    expect(res.status).toBe(405)
  })

  it('handles OPTIONS preflight with CORS headers', async () => {
    const res = await handleProxyRequest({
      request: makeRequest('OPTIONS', 'http://localhost/api-proxy/x/anything'),
      channel: undefined,
      path: 'anything',
      env: {},
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })
})

describe('handleProxyRequest keep-alive streaming', () => {
  it('returns 200 + chunked stream for successful upstream and the body parses as JSON', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Headers
      expect(headers.get('authorization')).toBe('Bearer sk-real')
      expect(url).toBe('https://api.example.com/v1/images/generations')
      return new Response('{"ok":true,"data":[1,2]}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations', {
        headers: {
          authorization: 'Bearer attacker-supplied',
          'content-type': 'application/json',
        },
        body: '{"prompt":"hi"}',
      }),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const json = await res.json()
    expect(json).toMatchObject({ ok: true, data: [1, 2] })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('injects query-key auth into upstream URL on gemini channels', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url)
      expect(u.searchParams.get('key')).toBe('AIza-real')
      expect(u.pathname).toBe('/v1beta/models/g1:generateContent')
      return new Response('{"candidates":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/models/g1:generateContent'),
      channel: queryKeyChannel,
      path: 'models/g1:generateContent',
      env: { GEMINI_KEY: 'AIza-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200)
    await res.json()
  })

  it('emits _proxyError envelope when upstream returns non-2xx, with OpenAI-style error.message extracted', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200) // 永远 200，错误走 body envelope
    const body = await res.json()
    expect(body).toMatchObject({
      _proxyError: true,
      error: { message: 'invalid api key', type: 'upstream_error', upstream_status: 401 },
    })
  })

  it('falls back to raw upstream body when error JSON has no standard message field', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('plain text error from upstream', {
        status: 500,
      })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      _proxyError: true,
      error: { message: 'plain text error from upstream', upstream_status: 500 },
    })
  })

  it('emits upstream_timeout envelope when upstream fetch is aborted', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
      throw new Error('unreachable')
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: { ...bearerChannel, defaults: { ...bearerChannel.defaults, timeout: 0.001 } },
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      _proxyError: true,
      error: { type: 'upstream_timeout' },
    })
  })

  it('emits heartbeat whitespace bytes during slow upstream and JSON still parses', async () => {
    // 模拟"慢上游"：fetch 等 80ms 才返回；心跳间隔 20ms。期间应该有 ≥ 3 个心跳字节先 flush。
    let upstreamResolved = false
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80))
      upstreamResolved = true
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
      heartbeatIntervalMs: 20,
    })

    expect(res.status).toBe(200)

    // 边读边检：在 upstream 返回前，前若干个 chunk 应该都是空格字节
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let assembled = ''
    let firstNonWhitespaceSeen = false
    let preBodyHeartbeatBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (!firstNonWhitespaceSeen) {
        // 数 leading whitespace
        for (const ch of chunk) {
          if (ch === ' ') preBodyHeartbeatBytes++
          else { firstNonWhitespaceSeen = true; break }
        }
      }
      assembled += chunk
    }

    expect(upstreamResolved).toBe(true)
    expect(preBodyHeartbeatBytes).toBeGreaterThanOrEqual(1) // 至少触发过 1 次心跳
    // JSON spec 允许任意 leading whitespace，下面这步等价于客户端 response.json()
    expect(JSON.parse(assembled)).toMatchObject({ ok: true })
  })

  it('aborts upstream fetch when the client cancels the response stream', async () => {
    let upstreamAborted = false
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          upstreamAborted = true
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
        // 永不主动 resolve；只能由 abort 中断
      })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations'),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
      heartbeatIntervalMs: 10,
    })

    // 立即取消客户端 stream，应触发 upstream fetch abort
    await res.body!.cancel()

    // cancel 是同步触发 controller.abort()，给 fetch mock 的 abort listener 一个 tick 走通
    await new Promise((r) => setTimeout(r, 5))
    expect(upstreamAborted).toBe(true)
  })
})
