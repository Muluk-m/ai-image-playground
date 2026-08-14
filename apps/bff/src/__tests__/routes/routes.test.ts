import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'

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
function requestIdFrom(json: unknown): string {
  if (!json || typeof json !== 'object' || !('request_id' in json)) {
    throw new Error('response is missing request_id')
  }
  if (typeof json.request_id !== 'string') throw new Error('request_id is not a string')
  return json.request_id
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
    const taskId = requestIdFrom(json)
    const [storedTask] = await db
      .select({ request_payload: schema.tasks.request_payload })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    expect(storedTask?.request_payload.input_images).toEqual([{ $blob: 0 }])
    const [storedBlob] = await db
      .select()
      .from(schema.task_blobs)
      .where(eq(schema.task_blobs.task_id, taskId))
      .limit(1)
    const originalBytes = Buffer.from(TINY_PNG.split(',')[1]!, 'base64')
    expect(storedBlob).toMatchObject({ kind: 'input', idx: 0, mime: 'image/png' })
    expect(storedBlob?.data).toEqual(originalBytes)

    await runTask(taskId)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as {
      get(name: string): unknown
      getAll(name: string): unknown[]
    }
    expect(form.get('prompt')).toBe('turn cat into dog')
    expect(form.getAll('image[]')).toHaveLength(1)
    const uploaded = form.getAll('image[]')[0]
    if (!(uploaded instanceof Blob)) throw new Error('multipart image is not a Blob')
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(originalBytes)
  })

  it('duplicate submit returns the existing task without orphaning input blobs', async () => {
    const input = 'data:image/png;base64,AQID'
    const request = submitBody({
      client_request_id: 'duplicate-input-request',
      input_images: [input],
    })

    const first = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request)
    const second = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request)

    expect(second.json).toMatchObject({ request_id: requestIdFrom(first.json) })
    expect(await db.select().from(schema.task_blobs)).toHaveLength(1)
  })

  it('concurrent duplicate submits create one task and consume quota once', async () => {
    const request = submitBody({
      client_request_id: 'concurrent-duplicate-request',
      n: 4,
      input_images: ['data:image/png;base64,AQID'],
    })

    const [first, second] = await Promise.all([
      jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request),
      jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(requestIdFrom(second.json)).toBe(requestIdFrom(first.json))
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(await db.select().from(schema.task_blobs)).toHaveLength(1)
    expect(await db.select().from(schema.daily_quota)).toEqual([
      expect.objectContaining({ count: 4 }),
    ])
  })

  it('rolls back the task when input blob storage fails', async () => {
    const sqlite = new Database(TEST_DB)
    sqlite.exec(`
      CREATE TRIGGER reject_input_blob
      BEFORE INSERT ON task_blobs
      WHEN NEW.kind = 'input'
      BEGIN
        SELECT RAISE(ABORT, 'input archive unavailable');
      END;
    `)
    try {
      const response = await app.handle(
        new Request('http://localhost/v1/queue/openai-compat/gpt-image-2/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(submitBody({ input_images: ['data:image/png;base64,AQID'] })),
        }),
      )
      expect(response.status).toBe(500)
    } finally {
      sqlite.exec('DROP TRIGGER reject_input_blob')
      sqlite.close()
    }

    expect(await db.select().from(schema.tasks)).toEqual([])
    expect(await db.select().from(schema.task_blobs)).toEqual([])
    expect(await db.select().from(schema.daily_quota)).toEqual([])
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

    // admin 排查要的是「上游到底回了什么」：状态码 + 原始 envelope 一并落库，
    // 否则只剩 extractErrorMessage 抽出来的那一句，error.code 之类全丢。
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(task).toMatchObject({
      upstream_status: 401,
      upstream_body: '{"error":{"message":"invalid api key"}}',
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
      // 压根没拿到 HTTP 响应，两个诊断列必须留空而不是瞎猜一个状态码
      upstream_status: null,
      upstream_body: null,
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
  it('GET result metadata and binary image resolve externalized output blobs', async () => {
    const id = 'externalized-result'
    const bytes = Buffer.from('stored-output')
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'completed',
      request_payload: { prompt: 'x' },
      result_payload: {
        data: [{}],
        _image_meta: [{ index: 0, mime: 'image/webp' }],
      },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    await db.insert(schema.task_blobs).values({
      id: crypto.randomUUID(),
      task_id: id,
      kind: 'output',
      idx: 0,
      mime: 'image/webp',
      data: bytes,
      created_at: Date.now(),
    })

    const meta = await jsonReq('GET', `/v1/queue/requests/${id}`)
    expect(meta.json).toMatchObject({
      status: 'completed',
      images: [{ index: 0, mime: 'image/webp' }],
    })
    const image = await app.handle(new Request(`http://localhost/v1/queue/requests/${id}/image/0`))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/webp')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes)
  })

  it('completes without images when output blob archival fails', async () => {
    const id = 'output-archive-failure'
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'queued',
      request_payload: { prompt: 'x' },
      submitted_at: Date.now(),
    })
    setUpstreamFetchForTesting(async () => {
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('pixel').toString('base64') }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const sqlite = new Database(TEST_DB)
    sqlite.exec(`
      CREATE TRIGGER reject_output_blob
      BEFORE INSERT ON task_blobs
      WHEN NEW.kind = 'output'
      BEGIN
        SELECT RAISE(ABORT, 'output archive unavailable');
      END;
    `)
    try {
      await runTask(id)
    } finally {
      sqlite.exec('DROP TRIGGER reject_output_blob')
      sqlite.close()
    }

    const [task] = await db
      .select({
        status: schema.tasks.status,
        resultPayload: schema.tasks.result_payload,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
    expect(task).toMatchObject({
      status: 'completed',
      resultPayload: { _images_dropped: true },
    })
    expect(
      await db.select().from(schema.task_blobs).where(eq(schema.task_blobs.task_id, id)),
    ).toEqual([])
    const meta = await jsonReq('GET', `/v1/queue/requests/${id}`)
    expect(meta.json).toMatchObject({ status: 'completed', images: [] })
  })

  it('GET binary image keeps serving legacy payload bytes', async () => {
    const id = 'legacy-result'
    const bytes = Buffer.from('legacy-output')
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'completed',
      request_payload: { prompt: 'x' },
      result_payload: { data: [{ b64_json: bytes.toString('base64') }] },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })

    const image = await app.handle(new Request(`http://localhost/v1/queue/requests/${id}/image/0`))
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes)
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

  it('PUT cancel archives queued input blobs as WebP', async () => {
    const id = 'cancel-input-archive'
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer()
    await db.insert(schema.tasks).values({
      id,
      provider: 'openai-compat',
      model: 'x',
      status: 'queued',
      request_payload: { prompt: 'x', input_images: [{ $blob: 0 }] },
      submitted_at: Date.now(),
    })
    await db.insert(schema.task_blobs).values({
      id: crypto.randomUUID(),
      task_id: id,
      kind: 'input',
      idx: 0,
      mime: 'image/png',
      data: png,
      created_at: Date.now(),
    })

    expect((await jsonReq('PUT', `/v1/queue/requests/${id}/cancel`)).status).toBe(200)
    const [blob] = await db
      .select({ mime: schema.task_blobs.mime })
      .from(schema.task_blobs)
      .where(eq(schema.task_blobs.task_id, id))
    expect(blob?.mime).toBe('image/webp')
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

  it('单次 submit 携带 n=4 按 4 张计配额；同 client_request_id 重放不重复扣', async () => {
    const device_id = 'quota-dev-native-n-0001'
    const request = submitBody({ device_id, n: 4, client_request_id: 'native-n-quota-replay' })

    const first = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request)
    expect(first.status).toBe(200)

    const [row] = await db
      .select({ count: schema.daily_quota.count })
      .from(schema.daily_quota)
      .where(eq(schema.daily_quota.device_id, device_id))
    expect(row?.count).toBe(4)

    // 页面刷新窗口期的幂等重放：返回同一 request_id，不再次扣减 n 张配额。
    const replay = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', request)
    expect(replay.status).toBe(200)
    expect(replay.json).toMatchObject({ request_id: requestIdFrom(first.json) })
    const [afterReplay] = await db
      .select({ count: schema.daily_quota.count })
      .from(schema.daily_quota)
      .where(eq(schema.daily_quota.device_id, device_id))
    expect(afterReplay?.count).toBe(4)
  })
})
