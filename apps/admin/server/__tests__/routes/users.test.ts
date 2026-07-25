import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { eq } from 'drizzle-orm'

const TEST_DB = './artifacts/test-admin-users.sqlite'
for (const suffix of ['', '-wal', '-shm']) {
  try {
    unlinkSync(`${TEST_DB}${suffix}`)
  } catch {}
}

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'

const { createDb, runMigrations } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
const passwordHash = await Bun.password.hash('initial-password', { algorithm: 'argon2id' })
await writer.db.insert(writer.schema.users).values([
  {
    id: 'user-existing',
    username: 'existing',
    password_hash: passwordHash,
    status: 'active',
    created_at: now,
    updated_at: now,
  },
  {
    id: 'user-status',
    username: 'status-user',
    password_hash: passwordHash,
    status: 'active',
    created_at: now + 1,
    updated_at: now + 1,
  },
  {
    id: 'user-reset',
    username: 'reset-user',
    password_hash: passwordHash,
    status: 'active',
    created_at: now + 2,
    updated_at: now + 2,
  },
  {
    id: 'user-revoke',
    username: 'revoke-user',
    password_hash: passwordHash,
    status: 'active',
    created_at: now + 3,
    updated_at: now + 3,
  },
])
await writer.db.insert(writer.schema.user_sessions).values([
  {
    token_hash: 'status-session',
    user_id: 'user-status',
    created_at: now,
    expires_at: now + 3600_000,
  },
  {
    token_hash: 'reset-session',
    user_id: 'user-reset',
    created_at: now,
    expires_at: now + 3600_000,
  },
  {
    token_hash: 'revoke-session-1',
    user_id: 'user-revoke',
    created_at: now,
    expires_at: now + 3600_000,
  },
  {
    token_hash: 'revoke-session-2',
    user_id: 'user-revoke',
    created_at: now,
    expires_at: now + 3600_000,
  },
])

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

describe('admin user routes', () => {
  it('requires the admin session', async () => {
    const response = await call('/api/users', { authenticated: false })
    expect(response.status).toBe(401)
  })

  it('lists users without password hashes', async () => {
    const response = await call('/api/users')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      users: Array<Record<string, unknown>>
      truncated: boolean
    }
    expect(body.users.map((user) => user.username)).toContain('existing')
    expect(body.users[0]).toHaveProperty('active_sessions')
    expect(body.users[0]).toHaveProperty('task_count')
    expect(body.users.some((user) => 'password_hash' in user)).toBe(false)
    expect(body.truncated).toBe(false)
  })

  it('creates an active user with a normalized username and Argon2id password', async () => {
    const response = await call('/api/users', {
      method: 'POST',
      body: { username: '  New.User  ', password: 'strong-password' },
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      user: { id: string; username: string; status: string }
    }
    expect(body.user).toMatchObject({ username: 'new.user', status: 'active' })

    const [stored] = await writer.db
      .select()
      .from(writer.schema.users)
      .where(eq(writer.schema.users.id, body.user.id))
      .limit(1)
    expect(stored).toBeDefined()
    expect(await Bun.password.verify('strong-password', stored!.password_hash)).toBe(true)
  })

  it('rejects duplicate usernames and weak credentials safely', async () => {
    const duplicate = await call('/api/users', {
      method: 'POST',
      body: { username: 'EXISTING', password: 'another-password' },
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'username_taken' })

    const invalid = await call('/api/users', {
      method: 'POST',
      body: { username: 'bad account', password: 'short' },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_username' })
  })

  it('disables a user and revokes all active sessions atomically', async () => {
    const response = await call('/api/users/user-status', {
      method: 'PATCH',
      body: { status: 'disabled' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: 'user-status', status: 'disabled', active_sessions: 0 },
    })

    const sessions = await writer.db
      .select()
      .from(writer.schema.user_sessions)
      .where(eq(writer.schema.user_sessions.user_id, 'user-status'))
    expect(sessions).toHaveLength(0)
  })

  it('resets a password and revokes existing sessions', async () => {
    const response = await call('/api/users/user-reset/reset-password', {
      method: 'POST',
      body: { password: 'replacement-password' },
    })
    expect(response.status).toBe(200)

    const [stored] = await writer.db
      .select()
      .from(writer.schema.users)
      .where(eq(writer.schema.users.id, 'user-reset'))
      .limit(1)
    expect(await Bun.password.verify('replacement-password', stored!.password_hash)).toBe(true)
    const sessions = await writer.db
      .select()
      .from(writer.schema.user_sessions)
      .where(eq(writer.schema.user_sessions.user_id, 'user-reset'))
    expect(sessions).toHaveLength(0)
  })

  it('revokes sessions on demand and reports the count', async () => {
    const response = await call('/api/users/user-revoke/revoke-sessions', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revoked: 2 })
  })

  it('returns 404 for an unknown user', async () => {
    const response = await call('/api/users/missing/revoke-sessions', { method: 'POST' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'user_not_found' })
  })
})
