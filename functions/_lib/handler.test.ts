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

describe('handleProxyRequest', () => {
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
      channel: undefined, // 不查 channel
      path: 'anything',
      env: {},
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('injects bearer Authorization and strips client-supplied Authorization', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Headers
      expect(headers.get('authorization')).toBe('Bearer sk-real')
      expect(url).toBe('https://api.example.com/v1/images/generations')
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/images/generations', {
        headers: {
          'authorization': 'Bearer attacker-supplied',
          'content-type': 'application/json',
        },
        body: '{"prompt":"hi"}',
      }),
      channel: bearerChannel,
      path: 'images/generations',
      env: { OPENAI_API_KEY: 'sk-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('injects query-key into upstream URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url)
      expect(u.searchParams.get('key')).toBe('AIza-real')
      expect(u.pathname).toBe('/v1beta/models/g1:generateContent')
      return new Response('{}', { status: 200 })
    })

    const res = await handleProxyRequest({
      request: makeRequest('POST', 'http://localhost/api-proxy/x/models/g1:generateContent'),
      channel: queryKeyChannel,
      path: 'models/g1:generateContent',
      env: { GEMINI_KEY: 'AIza-real' },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(res.status).toBe(200)
  })

  it('returns 504 on upstream timeout', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // 模拟 AbortError
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

    expect(res.status).toBe(504)
    expect(await res.json()).toMatchObject({ error: 'upstream_timeout' })
  })
})
