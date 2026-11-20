import { afterAll, describe, expect, it } from 'bun:test'
import { createObsClient, ObsQueryError, obsConnectionFromEnv } from '../obs-client'

interface Seen {
  path: string
  authorization: string | null
  body: { query: Record<string, unknown> }
}
const seen: Seen[] = []
let reply: (body: Seen['body']) => Response = () => Response.json({ hits: [] })

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Seen['body']
    const url = new URL(request.url)
    seen.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get('authorization'),
      body,
    })
    return reply(body)
  },
})
afterAll(() => server.stop(true))

const connection = { url: `http://127.0.0.1:${server.port}`, token: 'proxy-token', org: 'default' }

describe('obs client', () => {
  it('reads its connection from the service environment, or reports observability as off', () => {
    expect(
      obsConnectionFromEnv({ OBS_PROXY_URL: 'http://obs-proxy:5090/', OBS_PROXY_TOKEN: ' t ' }),
    ).toEqual({ url: 'http://obs-proxy:5090', token: 't', org: 'default' })
    expect(obsConnectionFromEnv({ OBS_PROXY_URL: 'http://obs-proxy:5090' })).toBeNull()
    expect(obsConnectionFromEnv({ OBS_PROXY_TOKEN: 't', OBS_PROXY_URL: '  ' })).toBeNull()
    expect(
      obsConnectionFromEnv({ OBS_PROXY_URL: 'http://x', OBS_PROXY_TOKEN: 't', OBS_ORG: 'ops' })
        ?.org,
    ).toBe('ops')
  })

  it('sends the SQL with the bearer token and the time range in microseconds', async () => {
    seen.length = 0
    reply = () => Response.json({ hits: [{ body: 'hello' }] })
    const hits = await createObsClient(connection).search({
      sql: 'SELECT 1',
      type: 'traces',
      startMs: 1_000,
      endMs: 2_000,
      size: 5,
    })
    expect(hits).toEqual([{ body: 'hello' }])
    expect(seen[0]).toEqual({
      path: '/api/default/_search?type=traces',
      authorization: 'Bearer proxy-token',
      body: {
        query: { sql: 'SELECT 1', start_time: 1_000_000, end_time: 2_000_000, from: 0, size: 5 },
      },
    })
  })

  it('pages until a short page and says when it stopped at the cap', async () => {
    seen.length = 0
    reply = ({ query }) =>
      Response.json({
        hits: Array.from({ length: Number(query.from) < 4 ? 2 : 1 }, (_, i) => ({
          n: Number(query.from) + i,
        })),
      })
    const client = createObsClient(connection)
    const full = await client.searchAll({ sql: 's', startMs: 0, endMs: 1 }, { pageSize: 2 })
    expect(full).toEqual({ records: [0, 1, 2, 3, 4].map((n) => ({ n })), truncated: false })

    const capped = await client.searchAll(
      { sql: 's', startMs: 0, endMs: 1 },
      { pageSize: 2, maxPages: 2 },
    )
    expect(capped.truncated).toBe(true)
    expect(capped.records).toHaveLength(4)
  })

  it('treats a stream that does not exist yet as no results', async () => {
    reply = () => Response.json({ message: 'Search stream not found' }, { status: 400 })
    expect(await createObsClient(connection).search({ sql: 's', startMs: 0, endMs: 1 })).toEqual([])
  })

  it('classifies failures so callers can show a useful state', async () => {
    const client = createObsClient(connection)
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => (error instanceof ObsQueryError ? error.failure : 'other'),
      )

    reply = () => Response.json({ error: 'unauthorized' }, { status: 401 })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('unauthorized')

    reply = () => Response.json({ message: 'syntax error' }, { status: 400 })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('failed')

    // 响应头已经 200，正文却不是结果：查询失败，不是「没有日志」。
    reply = () => new Response('<html>gateway</html>', { status: 200 })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('failed')
    reply = () => Response.json({ hits: [{ latest: 1 }], is_partial: true })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('failed')
    reply = () => Response.json({ took: 1 })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('failed')
    reply = () => new Response('denied', { status: 401 })
    expect(await failure(client.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('unauthorized')

    // 正文读到一半卡住，直到超时。
    const stalled = createObsClient(connection, {
      timeoutMs: 50,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"hits":['))
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
            },
          }),
          { status: 200 },
        ),
    })
    expect(await failure(stalled.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('timeout')

    const offline = createObsClient({ ...connection, url: 'http://127.0.0.1:9' })
    expect(await failure(offline.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('unreachable')

    const slow = createObsClient(connection, {
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    })
    expect(await failure(slow.search({ sql: 's', startMs: 0, endMs: 1 }))).toBe('timeout')
  })
})
