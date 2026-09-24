import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = await resetTestDatabase('bff_internal_users')
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')

// Dynamic imports keep environment setup ahead of BFF configuration capture.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')

const authorization = { authorization: 'Bearer fixture-service-credential-alpha' }

beforeEach(async () => {
  await db.delete(schema.operator_audits)
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
    const [audit] = await db.select().from(schema.operator_audits)
    expect(audit).toMatchObject({
      operator_id: 'admin',
      action: 'user.create',
      target_type: 'user',
      target_id: body.user.id,
      details: { username: 'alice.user' },
    })
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
    const [audit] = await db.select().from(schema.operator_audits)
    expect(audit).toMatchObject({
      operator_id: 'admin',
      action: 'user.status.update',
      target_type: 'user',
      target_id: 'disable-me',
      details: { status: 'disabled' },
    })
  })

  it('stores, updates and clears an operator-only note', async () => {
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'note-user',
      username: 'note-user',
      password_hash: 'hash',
      created_at: now,
      updated_at: now,
    })

    const unauthenticated = await request(
      '/internal/admin/users/note-user/note',
      'PATCH',
      { note: '合作方' },
      false,
    )
    expect(unauthenticated.status).toBe(401)

    const saved = await request('/internal/admin/users/note-user/note', 'PATCH', {
      note: '  合作方  ',
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ note: '合作方' })
    expect(await db.select().from(schema.admin_user_notes)).toMatchObject([
      { user_id: 'note-user', note: '合作方' },
    ])

    const updated = await request('/internal/admin/users/note-user/note', 'PATCH', {
      note: '下周跟进',
    })
    expect(updated.status).toBe(200)
    expect(await db.select().from(schema.admin_user_notes)).toMatchObject([
      { user_id: 'note-user', note: '下周跟进' },
    ])

    const cleared = await request('/internal/admin/users/note-user/note', 'PATCH', { note: '' })
    expect(cleared.status).toBe(200)
    expect(await db.select().from(schema.admin_user_notes)).toHaveLength(0)
    const audits = await db.select().from(schema.operator_audits)
    expect(audits.map((audit) => audit.details)).toEqual([
      { has_note: true },
      { has_note: true },
      { has_note: false },
    ])

    const missing = await request('/internal/admin/users/missing/note', 'PATCH', { note: 'x' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'user_not_found' })
    const tooLong = await request('/internal/admin/users/note-user/note', 'PATCH', {
      note: 'x'.repeat(501),
    })
    expect(tooLong.status).toBe(400)
  })
})
