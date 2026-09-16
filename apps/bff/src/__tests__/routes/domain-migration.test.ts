import { afterAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('domain_migration')
const dir = mkdtempSync(join(tmpdir(), 'aip-migration-'))
process.env.DOMAIN_MIGRATION_CONFIG_FILE = join(dir, 'config.json')
writeFileSync(
  process.env.DOMAIN_MIGRATION_CONFIG_FILE,
  JSON.stringify({
    sourceOrigin: 'https://old.example',
    targetOrigin: 'https://new.example',
    sourceApi: 'https://api.old.example',
    targetApi: 'https://api.new.example',
  }),
)
const { domainMigrationRoutes: app } = await import('../../routes/domain-migration')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, hashSessionToken, USER_SESSION_COOKIE } = await import(
  '../../lib/user-session'
)
const proof = 'a'.repeat(64)
let cookie = ''
async function call(
  route: string,
  body: unknown,
  side = 'source',
  session = cookie,
  origin?: string,
) {
  const host = side === 'source' ? 'old' : 'new'
  return app.handle(
    new Request(`https://api.${host}.example/api/domain-migration/${route}`, {
      method: 'POST',
      headers: {
        origin: origin ?? `https://${host}.example`,
        cookie: session,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
}
async function start() {
  const r = await call('start', { challenge: createHash('sha256').update(proof).digest('hex') })
  expect(r.status).toBe(200)
  return r.json() as Promise<{ id: string; uploadKey: string }>
}
beforeEach(async () => {
  await db.delete(schema.domain_migrations)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'owner',
    username: 'owner@example.test',
    password_hash: 'unused',
    created_at: now,
    updated_at: now,
  })
  const token = await db.transaction((tx) => createUserSession('owner', tx))
  cookie = `${USER_SESSION_COOKIE}=${token}`
})
afterAll(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

it('moves a valid session after a sealed encrypted transfer, once only', async () => {
  const transfer = await start()
  const data = { ...transfer, sequence: 0, ciphertext: 'encrypted-browser-only-data' }
  expect((await call('upload', data)).status).toBe(200)
  expect((await call('upload', data)).status).toBe(200)
  expect((await call('seal', { ...transfer, chunks: 1 })).status).toBe(200)
  const read = await call('read', { id: transfer.id, proof, sequence: 0 }, 'target', '')
  expect(await read.json()).toEqual({ chunks: 1, ciphertext: data.ciphertext })
  const finish = await call('finish', { id: transfer.id, proof }, 'target', '')
  expect(finish.status).toBe(200)
  const header = finish.headers.get('set-cookie')!
  expect(header).toContain('HttpOnly')
  expect(header).toContain('Secure')
  expect(header).not.toContain('Domain=')
  const token = header.split(';')[0]!.split('=')[1]!
  const [session] = await db
    .select()
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
  expect(session?.user_id).toBe('owner')
  expect((await call('finish', { id: transfer.id, proof }, 'target', '')).status).toBe(409)
  expect(await db.select().from(schema.domain_migration_chunks)).toHaveLength(0)
})
it('rejects foreign origins, wrong host and wrong possession proof', async () => {
  expect(
    (await call('start', { challenge: proof }, 'source', cookie, 'https://evil.example')).status,
  ).toBe(403)
  expect(
    (await call('start', { challenge: proof }, 'target', cookie, 'https://old.example')).status,
  ).toBe(403)
  const transfer = await start()
  await call('seal', { ...transfer, chunks: 0 })
  expect(
    (await call('read', { id: transfer.id, proof: 'b'.repeat(64), sequence: 0 }, 'target', ''))
      .status,
  ).toBe(410)
})
it('does not restore a revoked source session or replace another signed-in account', async () => {
  const transfer = await start()
  await call('seal', { ...transfer, chunks: 0 })
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'other',
    username: 'other@example.test',
    password_hash: 'unused',
    created_at: now,
    updated_at: now,
  })
  const other = await db.transaction((tx) => createUserSession('other', tx))
  expect(
    (
      await call(
        'read',
        { id: transfer.id, proof, sequence: 0 },
        'target',
        `${USER_SESSION_COOKIE}=${other}`,
      )
    ).status,
  ).toBe(409)
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.user_id, 'owner'))
  const result = await call('finish', { id: transfer.id, proof }, 'target', '')
  expect(result.status).toBe(409)
  expect(result.headers.get('set-cookie')).toBeNull()
})
it('supports anonymous data without inventing a login and rejects expired transfers', async () => {
  cookie = ''
  const transfer = await start()
  await call('seal', { ...transfer, chunks: 0 })
  const result = await call('finish', { id: transfer.id, proof }, 'target', '')
  expect(result.status).toBe(200)
  expect(result.headers.get('set-cookie')).toBeNull()
  const expired = await start()
  await call('seal', { ...expired, chunks: 0 })
  await db
    .update(schema.domain_migrations)
    .set({ expires_at: Date.now() - 1 })
    .where(eq(schema.domain_migrations.id, expired.id))
  expect((await call('read', { id: expired.id, proof, sequence: 0 }, 'target', '')).status).toBe(
    410,
  )
})
it('does not seal incomplete uploads or let a retry replace an accepted chunk', async () => {
  const transfer = await start()
  expect(
    (await call('upload', { ...transfer, sequence: 1, ciphertext: 'out-of-order' })).status,
  ).toBe(409)
  await call('upload', { ...transfer, sequence: 0, ciphertext: 'one' })
  expect((await call('upload', { ...transfer, sequence: 0, ciphertext: 'two' })).status).toBe(409)
  expect((await call('seal', { ...transfer, chunks: 2 })).status).toBe(409)
  expect((await call('read', { id: transfer.id, proof, sequence: 0 }, 'target', '')).status).toBe(
    410,
  )
})
