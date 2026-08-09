import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_authenticated_routes')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')

// Dynamic imports keep environment setup ahead of configuration capture.
const { config } = await import('../../config')
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
let storage: InMemoryObjectStore

beforeEach(() => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
})

afterEach(() => {
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
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
    await resetDb()
    process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
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
    expect(output.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
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

// Authenticated behavior tests follow.
