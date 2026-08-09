import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_users_route')
const forwarded: Array<{ method: string; path: string; authorization: string | null }> = []
const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    forwarded.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
    })
    return Response.json(
      request.method === 'POST' && url.pathname.endsWith('/users/')
        ? { user: { id: 'created-by-bff', username: 'new.user', status: 'active' } }
        : { ok: true },
      { status: request.method === 'POST' && url.pathname.endsWith('/users/') ? 201 : 200 },
    )
  },
})

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`
process.env.AUTH_ENABLED = 'true'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const now = Date.now()
await writer.db.insert(writer.schema.users).values([
  {
    id: 'user-existing',
    username: 'existing',
    password_hash: 'hash',
    status: 'active',
    created_at: now - 8 * 24 * 3600_000,
    updated_at: now,
    last_login_at: now - 3600_000,
  },
  {
    id: 'user-idle',
    username: 'idle-user',
    password_hash: 'hash',
    status: 'disabled',
    created_at: now - 40 * 24 * 3600_000,
    updated_at: now - 30 * 24 * 3600_000,
  },
])
await writer.db.insert(writer.schema.user_sessions).values({
  token_hash: 'active-session',
  user_id: 'user-existing',
  created_at: now - 1000,
  expires_at: now + 3600_000,
})
await writer.db.insert(writer.schema.tasks).values([
  {
    id: 'user-task-completed',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'finished image', device_id: 'device-user-1' },
    submitted_at: now - 30 * 60_000,
    completed_at: now - 29 * 60_000,
    user_id: 'user-existing',
  },
  {
    id: 'user-task-failed',
    provider: 'gemini',
    model: 'gemini-3-pro',
    status: 'failed',
    request_payload: { prompt: 'failed image', device_id: 'device-user-1' },
    submitted_at: now - 20 * 60_000,
    completed_at: now - 19 * 60_000,
    user_id: 'user-existing',
  },
])

// Dynamic import keeps environment setup ahead of Admin configuration capture.
const { app } = await import('../../app')

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.150' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; authenticated?: boolean } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.authenticated !== false) headers.set('cookie', await login())
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  )
}

afterAll(async () => {
  mockBff.stop()
  await writer.close()
})

describe('admin user routes', () => {
  it('requires the admin session', async () => {
    const response = await call('/api/users', { authenticated: false })
    expect(response.status).toBe(401)
  })

  it('lists searchable users with operational KPIs and no password hashes', async () => {
    const response = await call('/api/users?q=exist')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      users: Array<Record<string, unknown>>
      kpis: Record<string, number>
      truncated: boolean
    }
    expect(body.users).toHaveLength(1)
    expect(body.users[0]?.username).toBe('existing')
    expect(body.users[0]).toMatchObject({ active_sessions: 1, task_count: 2 })
    expect(body.users[0]).not.toHaveProperty('password_hash')
    expect(body.kpis).toMatchObject({ total_users: 2, active_users_7d: 1, submissions_24h: 2 })
    expect(body.kpis.failure_rate_24h).toBe(0.5)
    expect(body.truncated).toBe(false)
  })

  it('returns a filtered user task timeline and complete 24-hour buckets', async () => {
    const response = await call('/api/users/user-existing?range=1d&status=failed')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      user: { id: string }
      tasks: Array<Record<string, unknown>>
      volume: Array<{ total: number }>
    }
    expect(body.user.id).toBe('user-existing')
    expect(body.tasks).toEqual([
      {
        id: 'user-task-failed',
        status: 'failed',
        provider: 'gemini',
        model: 'gemini-3-pro',
        submitted_at: expect.any(Number),
        started_at: null,
        completed_at: expect.any(Number),
        error_type: null,
        prompt: 'failed image',
        n: null,
        attempt_count: 0,
      },
    ])
    expect(body.volume).toHaveLength(24)
    expect(body.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2)
  })

  it('returns 404 for an unknown user detail', async () => {
    const response = await call('/api/users/missing?range=7d')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'user_not_found' })
  })

  it('forwards mutations to BFF with service authentication', async () => {
    const response = await call('/api/users', {
      method: 'POST',
      body: { username: 'New.User', password: 'strong-password' },
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ user: { id: 'created-by-bff' } })
    expect(forwarded.at(-1)).toEqual({
      method: 'POST',
      path: '/internal/admin/users/',
      authorization: 'Bearer fixture-service-credential-alpha',
    })
    const stored = await writer.db.select().from(writer.schema.users)
    expect(stored.map((user) => user.id)).not.toContain('created-by-bff')
  })
})
