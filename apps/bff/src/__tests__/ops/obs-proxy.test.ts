import { describe, expect, it } from 'bun:test'
import {
  createObsProxy,
  OBS_PROXY_MAX_BODY_BYTES,
  OBS_PROXY_SLOW_MS,
  shouldLogObsProxyRequest,
} from '../../ops/obs-proxy'

const TOKEN = 't'.repeat(40)
const AUTH = { authorization: `Bearer ${TOKEN}` }

function proxy() {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = []
  const handle = createObsProxy({
    upstream: 'http://openobserve:5080/',
    org: 'default',
    token: TOKEN,
    username: 'root@example.test',
    password: 'secret-pass',
    fetchImpl: (async (input: string, init: RequestInit) => {
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : '',
      })
      return Response.json({ hits: [] })
    }) as unknown as typeof fetch,
  })
  return { handle, calls }
}

describe('OpenObserve 只读代理', () => {
  it('放行查询，代填 OpenObserve 账号，调用方的令牌不往后传', async () => {
    const { handle, calls } = proxy()
    const response = await handle(
      new Request('http://obs/api/default/_search?type=logs', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ query: { sql: 'SELECT * FROM "app"' } }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hits: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://openobserve:5080/api/default/_search?type=logs')
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('root@example.test:secret-pass').toString('base64')}`,
    )
    expect(calls[0]?.body).toContain('SELECT')
  })

  it('也放行 streams 列表与 trace 列表', async () => {
    const { handle, calls } = proxy()
    for (const path of ['/api/default/streams', '/api/default/default/traces/latest?size=5'])
      expect((await handle(new Request(`http://obs${path}`, { headers: AUTH }))).status).toBe(200)
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('令牌不对、没带令牌一律 401，不碰后端', async () => {
    const { handle, calls } = proxy()
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Basic ${TOKEN}` },
    ]
    for (const headers of cases) {
      const response = await handle(
        new Request('http://obs/api/default/_search', { method: 'POST', headers, body: '{}' }),
      )
      expect(response.status).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  it('写入、改配置、别的组织、换方法都 403', async () => {
    const { handle, calls } = proxy()
    const denied: [string, string][] = [
      ['POST', '/api/default/app/_json'],
      ['POST', '/api/default/v1/logs'],
      ['DELETE', '/api/default/streams/app'],
      ['PUT', '/api/default/settings'],
      ['POST', '/api/default/users'],
      ['GET', '/api/default/_search'],
      ['POST', '/api/other/_search'],
      ['POST', '/api/default/../other/_search'],
      ['GET', '/web/'],
    ]
    for (const [method, path] of denied) {
      const response = await handle(
        new Request(`http://obs${path}`, {
          method,
          headers: AUTH,
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
      )
      expect([method, path, response.status]).toEqual([method, path, 403])
    }
    expect(calls).toHaveLength(0)
  })

  it('查询体超过上限 413；后端不通 502；健康检查不要令牌', async () => {
    const { handle } = proxy()
    const big = await handle(
      new Request('http://obs/api/default/_search', {
        method: 'POST',
        headers: AUTH,
        body: 'x'.repeat(OBS_PROXY_MAX_BODY_BYTES + 1),
      }),
    )
    expect(big.status).toBe(413)

    // 分块上传不带 Content-Length：边读边数，超限就停，不先把整个请求体读进内存。
    let pulled = 0
    const chunk = new Uint8Array(16 * 1024)
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const streamed = await handle(
      new Request('http://obs/api/default/_search', {
        method: 'POST',
        headers: AUTH,
        body: endless,
        // @ts-expect-error Bun/undici 需要 duplex 才能发流式请求体
        duplex: 'half',
      }),
    )
    expect(streamed.status).toBe(413)
    expect(pulled).toBeLessThan(OBS_PROXY_MAX_BODY_BYTES * 4)

    // 上传中途出错：400，不往外抛。
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('client went away'))
      },
    })
    const aborted = await handle(
      new Request('http://obs/api/default/_search', {
        method: 'POST',
        headers: AUTH,
        body: broken,
        // @ts-expect-error Bun/undici 需要 duplex 才能发流式请求体
        duplex: 'half',
      }),
    )
    expect(aborted.status).toBe(400)

    const down = createObsProxy({
      upstream: 'http://openobserve:5080',
      org: 'default',
      token: TOKEN,
      username: 'u',
      password: 'p',
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const unavailable = await down(
      new Request('http://obs/api/default/_search', { method: 'POST', headers: AUTH, body: '{}' }),
    )
    expect(unavailable.status).toBe(502)
    expect((await handle(new Request('http://obs/healthz'))).status).toBe(200)
  })
})

describe('shouldLogObsProxyRequest', () => {
  it('skips health checks and fast successful queries', () => {
    expect(shouldLogObsProxyRequest('/healthz', 500, 10_000)).toBe(false)
    expect(shouldLogObsProxyRequest('/api/default/_search', 200, 120)).toBe(false)
    expect(shouldLogObsProxyRequest('/api/default/streams', 204, OBS_PROXY_SLOW_MS - 1)).toBe(false)
  })

  it('keeps failures and slow queries', () => {
    expect(shouldLogObsProxyRequest('/api/default/_search', 401, 3)).toBe(true)
    expect(shouldLogObsProxyRequest('/api/default/_search', 502, 3)).toBe(true)
    expect(shouldLogObsProxyRequest('/api/default/_search', 200, OBS_PROXY_SLOW_MS)).toBe(true)
  })
})
