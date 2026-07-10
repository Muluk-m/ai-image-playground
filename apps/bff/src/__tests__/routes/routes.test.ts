import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'

const TEST_DB = './artifacts/test-routes.sqlite'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'

const { runMigrations } = await import('../../db/migrate')
runMigrations(TEST_DB)
const { app } = await import('../../app')
const { db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

async function resetDb() {
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
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

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a cat',
    n: 1,
    device_id: 'test-device-aaaa-bbbb-cccc',
    client_request_id: crypto.randomUUID(),
    ...overrides,
  }
}

describe('BFF queue routes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    mock.restore()
  })

  it('GET /health returns ok', async () => {
    const { status, json } = await jsonReq('GET', '/health')
    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true })
  })

  it('POST submit only creates a queued task; worker execution stays outside the API process', async () => {
    let upstreamCalls = 0
    setUpstreamFetchForTesting(
      mock(async () => {
        upstreamCalls += 1
        return new Response(JSON.stringify({ data: [{ b64_json: 'fake' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as TestFetch,
    )

    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ prompt: 'a cat', size: '1024x1024' }),
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({ status: 'queued' })
    const id = (json as { request_id: string }).request_id

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(upstreamCalls).toBe(0)
    const taskStatus = await jsonReq('GET', `/v1/queue/requests/${id}/status`)
    expect(taskStatus.json).toMatchObject({ status: 'queued' })
  })

  it('POST submit with input_images routes to /v1/images/edits as multipart', async () => {
    const calls: Array<{ url: string; init: Parameters<TestFetch>[1] }> = []
    setUpstreamFetchForTesting(
      mock(async (input, init) => {
        calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
        return new Response(JSON.stringify({ data: [{ b64_json: 'fake' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as TestFetch,
    )

    // 1x1 透明 PNG 的 base64
    const TINY_PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=`

    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ prompt: 'turn cat into dog', size: '1024x1024', input_images: [TINY_PNG] }),
    )
    expect(status).toBe(200)
    await runTask((json as { request_id: string }).request_id)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as {
      get(name: string): unknown
      getAll(name: string): unknown[]
    }
    expect(form.get('prompt')).toBe('turn cat into dog')
    expect(form.getAll('image[]')).toHaveLength(1)
  })

  it('POST submit with mask routes to /v1/images/edits with mask field', async () => {
    const calls: Array<{ url: string; init: Parameters<TestFetch>[1] }> = []
    setUpstreamFetchForTesting(
      mock(async (input, init) => {
        calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
        return new Response(JSON.stringify({ data: [{ b64_json: 'fake' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as TestFetch,
    )

    const TINY_PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=`

    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ prompt: 'mask edit', input_images: [TINY_PNG], mask: TINY_PNG }),
    )
    expect(status).toBe(200)
    await runTask((json as { request_id: string }).request_id)

    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as {
      get(name: string): unknown
      getAll(name: string): unknown[]
    }
    expect(form.getAll('image[]')).toHaveLength(1)
    expect(form.get('mask')).toBeDefined()
  })

  it('worker captures upstream non-2xx as failed task with error message', async () => {
    setUpstreamFetchForTesting(
      mock(async () => {
        return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
        })
      }) as unknown as TestFetch,
    )

    const { json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ prompt: 'x' }),
    )
    const id = (json as { request_id: string }).request_id
    await runTask(id)

    const status = await jsonReq('GET', `/v1/queue/requests/${id}/status`)
    expect(status.json).toMatchObject({
      status: 'failed',
      error: { message: 'invalid api key' },
    })
  })

  it('worker marks a transport disconnect as unknown and does not queue a retry', async () => {
    setUpstreamFetchForTesting(
      mock(async () => {
        throw new Error('socket closed')
      }) as unknown as TestFetch,
    )

    const { json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ prompt: 'slow edit' }),
    )
    const id = (json as { request_id: string }).request_id
    await runTask(id)

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(task).toMatchObject({
      status: 'failed',
      error_type: 'upstream_result_unknown',
      next_retry_at: null,
    })
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
    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/unknown-provider/some-model/submit',
      submitBody({ prompt: 'x' }),
    )
    expect(status).toBe(400)
    expect(json).toMatchObject({ error: expect.stringContaining('unsupported provider') })
  })

  it('submit 缺失 device_id 返回 400', async () => {
    const { status } = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-1/submit', {
      prompt: 'a cat',
      n: 1,
    })
    expect(status).toBe(400)
  })

  it('submit device_id 太短返回 400', async () => {
    const { status } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-1/submit',
      submitBody({ device_id: 'short' }),
    )
    expect(status).toBe(400)
  })

  it('累计 8 次 n=10 后第 9 次返回 429 + daily_quota_exceeded', async () => {
    const device_id = 'quota-dev-aaaa-bbbb-cccc'
    for (let i = 0; i < 8; i++) {
      const { status } = await jsonReq(
        'POST',
        '/v1/queue/openai-compat/gpt-image-1/submit',
        submitBody({ device_id, n: 10, client_request_id: crypto.randomUUID() }),
      )
      expect(status).toBe(200)
    }
    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-1/submit',
      submitBody({ device_id, n: 1, client_request_id: crypto.randomUUID() }),
    )
    expect(status).toBe(429)
    expect(json).toMatchObject({
      error: 'daily_quota_exceeded',
      limit: 80,
      used: 80,
    })
    expect((json as { reset_at: string }).reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00/)
  })
})
