import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-routes.sqlite'

// 测试 DB 必须在 client.ts 被 import 之前清空，否则模块顶层创建的 sqlite
// handle 会指向旧 inode（即便我们 unlink 重建）。
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {
  /* not exists */
}

process.env.PORT = '0'
process.env.SUB2API_BASE_URL = 'http://localhost:9999'
process.env.SUB2API_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'

const { runMigrations } = await import('../../db/migrate')
runMigrations(TEST_DB)
const { app } = await import('../../app')
const { db, schema } = await import('../../db/client')

async function resetDb() {
  await db.delete(schema.tasks)
}

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    }),
  )
  return { status: res.status, json: await res.json() }
}

describe('BFF queue routes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(() => {
    mock.restore()
  })

  it('GET /health returns ok', async () => {
    const { status, json } = await jsonReq('GET', '/health')
    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true })
  })

  it('POST submit creates a queued task and worker eventually marks completed when upstream returns 200', async () => {
    // 替换 fetch 让 upstream worker 拿到稳定 ok 响应
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ data: [{ b64_json: 'fake' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const { status, json } = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', {
        prompt: 'a cat',
        size: '1024x1024',
      })
      expect(status).toBe(200)
      expect(json).toMatchObject({ status: 'queued' })
      const id = (json as { request_id: string }).request_id

      // 等待 worker 写完成（fire-and-forget）
      await new Promise((r) => setTimeout(r, 50))

      const result = await jsonReq('GET', `/v1/queue/requests/${id}`)
      expect(result.status).toBe(200)
      expect(result.json).toMatchObject({
        status: 'completed',
        images: [{ index: 0, mime: 'image/png' }],
      })

      // 二进制端点应返回 base64 解码后的原始字节
      const binRes = await app.handle(
        new Request(`http://localhost/v1/queue/requests/${id}/image/0`),
      )
      expect(binRes.status).toBe(200)
      expect(binRes.headers.get('content-type')).toBe('image/png')
      const bytes = new Uint8Array(await binRes.arrayBuffer())
      // 'fake' base64 解码后的原始字节
      expect(Buffer.from(bytes).toString('base64')).toBe('fake')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('POST submit with input_images routes to /v1/images/edits as multipart', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify({ data: [{ b64_json: 'fake' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    // 1x1 透明 PNG 的 base64
    const TINY_PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=`

    try {
      const { status } = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', {
        prompt: 'turn cat into dog',
        size: '1024x1024',
        input_images: [TINY_PNG],
      })
      expect(status).toBe(200)
      // 等 worker 触发 upstream fetch
      await new Promise((r) => setTimeout(r, 50))

      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
      const body = calls[0]!.init?.body
      expect(body).toBeInstanceOf(FormData)
      const form = body as FormData
      expect(form.get('prompt')).toBe('turn cat into dog')
      expect(form.getAll('image[]')).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('worker captures upstream non-2xx as failed task with error message', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
      })
    }) as unknown as typeof fetch

    try {
      const { json } = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', {
        prompt: 'x',
      })
      const id = (json as { request_id: string }).request_id
      await new Promise((r) => setTimeout(r, 50))

      const status = await jsonReq('GET', `/v1/queue/requests/${id}/status`)
      expect(status.json).toMatchObject({
        status: 'failed',
        error: { message: 'invalid api key' },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('GET status returns 404 for unknown id', async () => {
    const { status } = await jsonReq('GET', '/v1/queue/requests/nope/status')
    expect(status).toBe(404)
  })

  it('GET result returns 425 while task still queued', async () => {
    // 不替换 fetch；worker 会真去 connect 9999 失败。但我们抢在 worker 完成前测。
    // 用直接插入数据库的方式构造 queued 但 worker 未跑的状态。
    const id = 'pending-test-id'
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'queued',
      request_payload: { prompt: 'x' },
      submitted_at: Date.now(),
    })

    const { status } = await jsonReq('GET', `/v1/queue/requests/${id}`)
    expect(status).toBe(425)
  })

  it('PUT cancel marks queued task as cancelled', async () => {
    const id = 'cancel-test-id'
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'queued',
      request_payload: { prompt: 'x' },
      submitted_at: Date.now(),
    })

    const { status, json } = await jsonReq('PUT', `/v1/queue/requests/${id}/cancel`)
    expect(status).toBe(200)
    expect(json).toMatchObject({ status: 'cancelled' })
  })

  it('POST submit rejects invalid provider', async () => {
    const { status, json } = await jsonReq('POST', '/v1/queue/unknown-provider/some-model/submit', {
      prompt: 'x',
    })
    expect(status).toBe(400)
    expect(json).toMatchObject({ error: expect.stringContaining('unsupported provider') })
  })
})
