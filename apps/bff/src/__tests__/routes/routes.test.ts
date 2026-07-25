import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'

const TEST_DB = './artifacts/test-routes.sqlite'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.AUTH_ENABLED = 'false'

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

  it('uses one generic login failure and issues a hardened opaque cookie on success', async () => {
    await createTestUser('alice', 'correct-horse')

    const unknown = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'nobody', password: 'wrong-password' },
      { 'cf-connecting-ip': '10.10.0.1' },
    )
    const wrong = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'alice', password: 'wrong-password' },
      { 'cf-connecting-ip': '10.10.0.2' },
    )
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.json).toEqual({ error: 'invalid_credentials' })
    expect(wrong.json).toEqual({ error: 'invalid_credentials' })

    const login = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: ' Alice ', password: 'correct-horse' },
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
    await createTestUser('brute-target', 'correct-horse')
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await jsonReq(
        'POST',
        '/api/auth/login',
        { username: 'brute-target', password: 'wrong-password' },
        { 'cf-connecting-ip': `10.20.0.${attempt + 1}` },
      )
      expect(response.status).toBe(401)
    }
    const locked = await jsonReq(
      'POST',
      '/api/auth/login',
      { username: 'brute-target', password: 'wrong-password' },
      { 'cf-connecting-ip': '10.20.0.99' },
    )
    expect(locked.status).toBe(429)
    expect(locked.json).toEqual({ error: 'rate_limited' })
  })

  it('stores user ownership and hides every task endpoint from other users', async () => {
    const alice = await createTestUser('alice', 'correct-horse')
    await createTestUser('bob', 'correct-horse')
    const aliceCookie = await loginTestUser('alice', 'correct-horse', '10.10.1.1')
    const bobCookie = await loginTestUser('bob', 'correct-horse', '10.10.1.2')

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
    const alice = await createTestUser('alice', 'correct-horse')
    const cookie = await loginTestUser('alice', 'correct-horse', '10.10.2.1')

    const me = await jsonReq('GET', '/api/auth/me', undefined, { cookie })
    expect(me.status).toBe(200)

    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, alice.id))
    const disabledMe = await jsonReq('GET', '/api/auth/me', undefined, { cookie })
    expect(disabledMe.status).toBe(401)

    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, alice.id))
    const nextCookie = await loginTestUser('alice', 'correct-horse', '10.10.2.2')
    const logout = await jsonReq('POST', '/api/auth/logout', undefined, { cookie: nextCookie })
    expect(logout.status).toBe(200)
    const sessions = await db.select().from(schema.user_sessions)
    expect(sessions).toHaveLength(0)
    const loggedOutMe = await jsonReq('GET', '/api/auth/me', undefined, { cookie: nextCookie })
    expect(loggedOutMe.status).toBe(401)
  })
})
