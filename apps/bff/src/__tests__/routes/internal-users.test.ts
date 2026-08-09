import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = await resetTestDatabase('bff_internal_users')
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.AUTH_ENABLED = 'true'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')

// Dynamic imports keep environment setup ahead of BFF configuration capture.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')

const authorization = { authorization: 'Bearer fixture-service-credential-alpha' }

beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
})

afterAll(async () => {
  await closeDb()
})

function request(path: string, method: string, body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(authenticated ? authorization : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

describe('internal user operations', () => {
  it('rejects callers without the service credential', async () => {
    const response = await request(
      '/internal/admin/users/',
      'POST',
      { username: 'alice', password: 'strong-password' },
      false,
    )
    expect(response.status).toBe(401)
  })

  it('creates normalized users with Argon2id credentials', async () => {
    const response = await request('/internal/admin/users/', 'POST', {
      username: '  Alice.User  ',
      password: 'strong-password',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { user: { id: string; username: string } }
    expect(body.user.username).toBe('alice.user')
    const [stored] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, body.user.id))
      .limit(1)
    expect(await Bun.password.verify('strong-password', stored!.password_hash)).toBe(true)
  })

  it('disables a user and revokes sessions in one transaction', async () => {
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'disable-me',
      username: 'disable-me',
      password_hash: 'hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.user_sessions).values({
      token_hash: 'session',
      user_id: 'disable-me',
      created_at: now,
      expires_at: now + 60_000,
    })

    const response = await request('/internal/admin/users/disable-me', 'PATCH', {
      status: 'disabled',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { status: 'disabled' } })
    expect(await db.select().from(schema.user_sessions)).toHaveLength(0)
  })
})
