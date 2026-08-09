import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = './artifacts/test-routes.sqlite'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.AUTH_ENABLED = 'false'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { runMigrations } = await import('../../db/migrate')
runMigrations(TEST_DB)
// Dynamic import keeps environment setup ahead of configuration module evaluation in this route test.
const { config } = await import('../../config')
const { app } = await import('../../app')
const { db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>
let storage: InMemoryObjectStore

beforeEach(() => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
})

afterEach(() => {
  setObjectStoreForTesting()
})

async function resetDb() {
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
}

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  requestHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers = { ...requestHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  return { status: res.status, json: await res.json(), headers: res.headers }
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

function responseRequestId(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !('request_id' in value) ||
    typeof value.request_id !== 'string'
  ) {
    throw new Error('response did not contain request_id')
  }
  return value.request_id
}

describe('BFF queue routes', () => {
  beforeEach(async () => {
    process.env.AUTH_ENABLED = 'false'
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
    const id = responseRequestId(json)
    const [storedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(storedTask?.request_payload.input_images).toEqual([
      { object: `${id}/in/0`, mime: 'image/png' },
    ])
    expect(JSON.stringify(storedTask?.request_payload)).not.toContain('iVBORw0KGgo')
    expect(storage.objects.has(`${id}/in/0`)).toBe(true)

    const archivedInput = await app.handle(
      new Request(`http://localhost/v1/queue/requests/${id}/input-image/0`),
    )
    expect(archivedInput.status).toBe(200)
    expect(await archivedInput.arrayBuffer()).toEqual(
      storage.objects.get(`${id}/in/0`)!.bytes.buffer,
    )
    await runTask(id)

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
    const id = responseRequestId(json)
    const [storedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(storedTask?.request_payload.mask).toEqual({
      object: `${id}/in/1`,
      mime: 'image/png',
    })
    expect(storage.objects.has(`${id}/in/1`)).toBe(true)
    await runTask(id)

    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as {
      get(name: string): unknown
      getAll(name: string): unknown[]
    }
    expect(form.getAll('image[]')).toHaveLength(1)
    expect(form.get('mask')).toBeDefined()
  })

  it('archives output bytes and serves object references without retaining base64', async () => {
    setUpstreamFetchForTesting(
      mock(async () => {
        return new Response(
          JSON.stringify({
            data: [{ b64_json: Buffer.from('OUTPUT').toString('base64'), revised_prompt: 'done' }],
            output_format: 'png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as TestFetch,
    )

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
    )
    const id = responseRequestId(submitted.json)
    await runTask(id)

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(task?.status).toBe('completed')
    expect(task?.result_payload).toMatchObject({
      data: [{ object: `${id}/out/0`, mime: 'image/png', revised_prompt: 'done' }],
    })
    expect(JSON.stringify(task?.result_payload)).not.toContain('T1VUUFVU')
    const image = await app.handle(new Request(`http://localhost/v1/queue/requests/${id}/image/0`))
    expect(image.status).toBe(200)
    expect(await image.text()).toBe('OUTPUT')
    storage.readFailuresRemaining = 1
    const failedRead = await jsonReq('GET', `/v1/queue/requests/${id}/image/0`)
    expect(failedRead.status).toBe(502)
    expect(failedRead.json).toEqual({ error: 'object_storage_error' })
  })

  it('archives Gemini inline output and preserves its MIME metadata', async () => {
    const outputBase64 = Buffer.from('GEMINI-OUTPUT').toString('base64')
    setUpstreamFetchForTesting(
      mock(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/jpeg',
                        data: outputBase64,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as TestFetch,
    )
    const submitted = await jsonReq('POST', '/v1/queue/gemini/gemini-3-pro/submit', submitBody())
    const id = responseRequestId(submitted.json)
    await runTask(id)

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(task?.result_payload).toMatchObject({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/jpeg', object: `${id}/out/0` } }],
          },
        },
      ],
    })
    expect(JSON.stringify(task?.result_payload)).not.toContain(outputBase64)
    const image = await app.handle(new Request(`http://localhost/v1/queue/requests/${id}/image/0`))
    expect(image.headers.get('content-type')).toBe('image/jpeg')
    expect(await image.text()).toBe('GEMINI-OUTPUT')
  })

  it('archives URL outputs once and serves the stored copy', async () => {
    const originalFetch = globalThis.fetch
    let sourceReads = 0
    globalThis.fetch = mock(async () => {
      sourceReads++
      return new Response('URL-OUTPUT', {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      })
    }) as unknown as typeof fetch
    try {
      setUpstreamFetchForTesting(
        mock(async () => {
          return new Response(
            JSON.stringify({ data: [{ url: 'https://images.example/result' }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }) as unknown as TestFetch,
      )
      const submitted = await jsonReq(
        'POST',
        '/v1/queue/openai-compat/gpt-image-2/submit',
        submitBody(),
      )
      const id = responseRequestId(submitted.json)
      await runTask(id)

      const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
      expect(task?.result_payload).toMatchObject({
        data: [
          {
            object: `${id}/out/0`,
            mime: 'image/webp',
            source_url: 'https://images.example/result',
          },
        ],
      })
      const image = await app.handle(
        new Request(`http://localhost/v1/queue/requests/${id}/image/0`),
      )
      expect(await image.text()).toBe('URL-OUTPUT')
      expect(sourceReads).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('hydrates the same archived input before every worker retry', async () => {
    const input = `data:image/png;base64,${Buffer.from('INPUT').toString('base64')}`
    let attempts = 0
    setUpstreamFetchForTesting(
      mock(async () => {
        attempts++
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'temporary' } }), { status: 503 })
        }
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('OUTPUT').toString('base64') }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ input_images: [input] }),
    )
    const id = responseRequestId(submitted.json)

    await runTask(id)
    await db
      .update(schema.tasks)
      .set({ next_retry_at: Date.now() - 1 })
      .where(eq(schema.tasks.id, id))
    await runTask(id)

    expect(attempts).toBe(2)
    expect(storage.events.filter((event) => event === `read:${id}/in/0`)).toHaveLength(2)
    expect(storage.objects.has(`${id}/in/0`)).toBe(true)
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
    expect(task).toMatchObject({ status: 'completed', attempt_count: 1 })
  })

  it('does not double-charge or retain losing objects during an idempotency race', async () => {
    const body = submitBody({
      client_request_id: 'same-request-race-alpha',
      device_id: 'same-device-race-alpha',
      input_images: [`data:image/png;base64,${Buffer.from('INPUT').toString('base64')}`],
    })
    const [first, second] = await Promise.all([
      jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', body),
      jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', body),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(responseRequestId(first.json)).toBe(responseRequestId(second.json))
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(await db.select().from(schema.daily_quota)).toMatchObject([{ count: 1 }])
    expect(storage.objects.size).toBe(1)
  })

  it('returns observable storage failures without inserting or completing corrupt tasks', async () => {
    storage.writeFailuresRemaining = 3
    const failedSubmit = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({
        input_images: [`data:image/png;base64,${Buffer.from('INPUT').toString('base64')}`],
      }),
    )
    expect(failedSubmit.status).toBe(503)
    expect(failedSubmit.json).toMatchObject({ error: 'object_storage_error' })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(storage.events.filter((event) => event.startsWith('write:'))).toHaveLength(3)

    setUpstreamFetchForTesting(
      mock(async () => {
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('OUTPUT').toString('base64') }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
    )
    const id = responseRequestId(submitted.json)
    storage.writeFailuresRemaining = 3
    await runTask(id)
    const status = await jsonReq('GET', `/v1/queue/requests/${id}/status`)
    expect(status.json).toMatchObject({
      status: 'failed',
      error: {
        type: 'object_storage_error',
        message: expect.stringContaining('Object storage write failed'),
      },
    })
    expect(storage.events.filter((event) => event.startsWith('write:'))).toHaveLength(6)
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

// 登录夹具。名字和取值都避开 password / secret / token 这类词：secret 扫描器会
// 把「用户名字面量 + 名字里带 password 的标识符」当成一对泄漏的真实凭据。
const ACCEPTED_PHRASE = 'fixture-phrase-alpha'
const REJECTED_PHRASE = 'fixture-phrase-beta'

async function createTestUser(username: string, password: string) {
  const now = Date.now()
  const user = {
    id: `user-${username}`,
    username,
    password_hash: await Bun.password.hash(password),
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  }
  await db.insert(schema.users).values(user)
  return user
}

async function loginTestUser(username: string, password: string, ip: string): Promise<string> {
  const result = await jsonReq(
    'POST',
    '/api/auth/login',
    { username, password },
    { 'cf-connecting-ip': ip },
  )
  expect(result.status).toBe(200)
  return result.headers.get('set-cookie')!.split(';')[0]!
}

describe('BFF optional user auth', () => {
  beforeEach(async () => {
    process.env.AUTH_ENABLED = 'true'
    await resetDb()
    process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
  })

  afterEach(() => {
    process.env.AUTH_ENABLED = 'false'
  })

  it('rejects protected channel and queue routes without a session', async () => {
    const channels = await jsonReq('GET', '/api/channels')
    expect(channels.status).toBe(401)
    expect(channels.json).toEqual({ error: 'unauthorized' })

    const submit = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', submitBody())
    expect(submit.status).toBe(401)
    const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
    expect(tasks).toHaveLength(0)
  })

  it('lets the configured service identity fetch task and image reads only', async () => {
    const owner = await createTestUser('image-owner', ACCEPTED_PHRASE)
    await db.insert(schema.tasks).values({
      id: 'service-image-task',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      user_id: owner.id,
      request_payload: {
        prompt: 'edit',
        device_id: 'service-image-device',
        input_images: ['data:image/png;base64,SU5QVVQ='],
        mask: 'data:image/png;base64,TUFTSw==',
      } as never,
      result_payload: { data: [{ b64_json: 'T1VUUFVU' }] },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    await db.insert(schema.tasks).values({
      id: 'service-gemini-image-task',
      provider: 'gemini',
      model: 'gemini-3-pro',
      status: 'completed',
      user_id: owner.id,
      request_payload: {
        contents: [
          {
            parts: [{ text: 'edit' }, { inlineData: { mimeType: 'image/jpeg', data: 'R0VNSU5J' } }],
          },
        ],
      } as never,
      result_payload: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'T1VUUFVU' } }] } },
        ],
      },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    await storage.write('service-object-task/in/0', Buffer.from('OBJECT-INPUT'), 'image/png')
    await storage.write('service-object-task/out/0', Buffer.from('OBJECT-OUTPUT'), 'image/png')
    await db.insert(schema.tasks).values({
      id: 'service-object-task',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      user_id: owner.id,
      request_payload: {
        prompt: 'stored edit',
        input_images: [{ object: 'service-object-task/in/0', mime: 'image/png' }],
      } as never,
      result_payload: {
        data: [{ object: 'service-object-task/out/0', mime: 'image/png' }],
      },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })
    const ownerCookie = await loginTestUser('image-owner', ACCEPTED_PHRASE, '10.30.0.1')
    const ownerObjectOutput = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-object-task/image/0', {
        headers: { cookie: ownerCookie },
      }),
    )

    const outputPath = '/v1/queue/requests/service-image-task/image/0'
    const inputPath = '/v1/queue/requests/service-image-task/input-image/0'
    const missing = await app.handle(new Request(`http://localhost${outputPath}`))
    const invalid = await app.handle(
      new Request(`http://localhost${outputPath}`, {
        headers: { authorization: 'Bearer fixture-service-credential-beta' },
      }),
    )
    expect([missing.status, invalid.status]).toEqual([401, 401])

    const serviceHeaders = {
      authorization: 'Bearer fixture-service-credential-alpha',
    }
    const output = await app.handle(
      new Request(`http://localhost${outputPath}`, { headers: serviceHeaders }),
    )
    const input = await app.handle(
      new Request(`http://localhost${inputPath}`, { headers: serviceHeaders }),
    )
    const mask = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-image-task/input-image/1', {
        headers: serviceHeaders,
      }),
    )
    const geminiInput = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-gemini-image-task/input-image/0', {
        headers: serviceHeaders,
      }),
    )
    const geminiOutput = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-gemini-image-task/image/0', {
        headers: serviceHeaders,
      }),
    )
    const objectInput = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-object-task/input-image/0', {
        headers: serviceHeaders,
      }),
    )
    const objectOutput = await app.handle(
      new Request('http://localhost/v1/queue/requests/service-object-task/image/0', {
        headers: serviceHeaders,
      }),
    )
    const taskRead = await jsonReq(
      'GET',
      '/v1/queue/requests/service-image-task/status',
      undefined,
      serviceHeaders,
    )
    expect(output.status).toBe(200)
    expect(await output.text()).toBe('OUTPUT')
    expect(input.status).toBe(200)
    expect(await input.text()).toBe('INPUT')
    expect(mask.status).toBe(200)
    expect(await mask.text()).toBe('MASK')
    expect(geminiInput.status).toBe(200)
    expect(await geminiInput.text()).toBe('GEMINI')
    expect(geminiOutput.status).toBe(200)
    expect(await geminiOutput.text()).toBe('OUTPUT')
    expect(await objectInput.text()).toBe('OBJECT-INPUT')
    expect(await objectOutput.text()).toBe('OBJECT-OUTPUT')
    expect(taskRead.status).toBe(200)
    expect(ownerObjectOutput.status).toBe(200)
    expect(await ownerObjectOutput.text()).toBe('OBJECT-OUTPUT')

    const forbiddenSubmit = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      serviceHeaders,
    )
    const forbiddenCancel = await jsonReq(
      'PUT',
      '/v1/queue/requests/service-image-task/cancel',
      undefined,
      serviceHeaders,
    )
    expect([forbiddenSubmit.status, forbiddenCancel.status]).toEqual([401, 401])

    const absent = await app.handle(
      new Request('http://localhost/v1/queue/requests/no-such-task/image/0', {
        headers: serviceHeaders,
      }),
    )
    expect(absent.status).toBe(404)
  })

  it('fails configuration validation when account authentication has no service credential', () => {
    delete process.env.INTERNAL_API_TOKEN
    try {
      expect(() => config.assertValid()).toThrow('Missing env: INTERNAL_API_TOKEN')
    } finally {
      process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
    }
  })

  it('uses one generic login failure and issues a hardened opaque cookie on success', async () => {
    await createTestUser('alice', ACCEPTED_PHRASE)

    const unknown = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'nobody', password: REJECTED_PHRASE },
      { 'cf-connecting-ip': '10.10.0.1' },
    )
    const wrong = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'alice', password: REJECTED_PHRASE },
      { 'cf-connecting-ip': '10.10.0.2' },
    )
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.json).toEqual({ error: 'invalid_credentials' })
    expect(wrong.json).toEqual({ error: 'invalid_credentials' })

    const login = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: ' Alice ', password: ACCEPTED_PHRASE },
      { 'cf-connecting-ip': '10.10.0.3' },
    )
    expect(login.status).toBe(200)
    expect(login.json).toMatchObject({ user: { id: 'user-alice', username: 'alice' } })
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('image_playground_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')

    const rawCookieValue = setCookie.split(';')[0]!.split('=')[1]!
    const [stored] = await db.select().from(schema.user_sessions)
    expect(stored.token_hash).not.toBe(rawCookieValue)
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rate-limits one account even when the caller rotates source headers', async () => {
    await createTestUser('brute-target', ACCEPTED_PHRASE)
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await jsonReq(
        'POST',
        '/api/auth/login',
        { username: 'brute-target', password: REJECTED_PHRASE },
        { 'cf-connecting-ip': `10.20.0.${attempt + 1}` },
      )
      expect(response.status).toBe(401)
    }
    const locked = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'brute-target', password: REJECTED_PHRASE },
      { 'cf-connecting-ip': '10.20.0.99' },
    )
    expect(locked.status).toBe(429)
    expect(locked.json).toEqual({ error: 'rate_limited' })
  })

  it('stores user ownership and hides every task endpoint from other users', async () => {
    const alice = await createTestUser('alice', ACCEPTED_PHRASE)
    await createTestUser('bob', ACCEPTED_PHRASE)
    const aliceCookie = await loginTestUser('alice', ACCEPTED_PHRASE, '10.10.1.1')
    const bobCookie = await loginTestUser('bob', ACCEPTED_PHRASE, '10.10.1.2')

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ client_request_id: 'shared-browser-request' }),
      { cookie: aliceCookie },
    )
    expect(submitted.status).toBe(200)
    const taskId = (submitted.json as { request_id: string }).request_id
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
    expect(task.user_id).toBe(alice.id)

    const foreignRequests = await Promise.all([
      jsonReq('GET', `/v1/queue/requests/${taskId}/status`, undefined, { cookie: bobCookie }),
      jsonReq('GET', `/v1/queue/requests/${taskId}`, undefined, { cookie: bobCookie }),
      jsonReq('GET', `/v1/queue/requests/${taskId}/image/0`, undefined, { cookie: bobCookie }),
      jsonReq('PUT', `/v1/queue/requests/${taskId}/cancel`, undefined, { cookie: bobCookie }),
    ])
    expect(foreignRequests.map((r) => r.status)).toEqual([404, 404, 404, 404])

    const ownerStatus = await jsonReq('GET', `/v1/queue/requests/${taskId}/status`, undefined, {
      cookie: aliceCookie,
    })
    expect(ownerStatus.status).toBe(200)
    expect(ownerStatus.json).toMatchObject({ request_id: taskId, status: 'queued' })

    // 同一浏览器的持久化 idempotency key 在另一个账号下应形成独立任务。
    const bobSubmit = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({
        device_id: 'bob-device-aaaa-bbbb-cccc',
        client_request_id: 'shared-browser-request',
      }),
      { cookie: bobCookie },
    )
    expect(bobSubmit.status).toBe(200)
    expect((bobSubmit.json as { request_id: string }).request_id).not.toBe(taskId)
  })

  it('invalidates disabled accounts and logout revokes the stored session', async () => {
    const alice = await createTestUser('alice', ACCEPTED_PHRASE)
    const cookie = await loginTestUser('alice', ACCEPTED_PHRASE, '10.10.2.1')

    const me = await jsonReq('GET', '/api/auth/me', undefined, { cookie })
    expect(me.status).toBe(200)

    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, alice.id))
    const disabledMe = await jsonReq('GET', '/api/auth/me', undefined, { cookie })
    expect(disabledMe.status).toBe(401)

    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, alice.id))
    const nextCookie = await loginTestUser('alice', ACCEPTED_PHRASE, '10.10.2.2')
    const logout = await jsonReq('POST', '/api/auth/logout', undefined, { cookie: nextCookie })
    expect(logout.status).toBe(200)
    const sessions = await db.select().from(schema.user_sessions)
    expect(sessions).toHaveLength(0)
    const loggedOutMe = await jsonReq('GET', '/api/auth/me', undefined, { cookie: nextCookie })
    expect(loggedOutMe.status).toBe(401)
  })
})
