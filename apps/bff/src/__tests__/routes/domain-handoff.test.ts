import { afterAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const directory = mkdtempSync(resolve(tmpdir(), 'domain-handoff-'))
process.env.DATABASE_URL = await resetTestDatabase('bff_domain_handoff')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.DOMAIN_HANDOFF_CONFIG_FILE = resolve(directory, 'handoff.json')
writeFileSync(
  process.env.DOMAIN_HANDOFF_CONFIG_FILE,
  JSON.stringify({
    sourceOrigin: 'https://old.example',
    targetOrigin: 'https://new.example',
    sourceApiOrigin: 'https://api.old.example',
    targetApiOrigin: 'https://api.new.example',
  }),
)
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, hashSessionToken, resolveUserSession } = await import(
  '../../lib/user-session'
)
const sessionName = 'image_playground_session'
const bindingName = '__Host-image_playground_domain_handoff'
function cookie(response: Response, name: string): string {
  return (
    response.headers
      .getSetCookie()
      .find((s) => s.startsWith(`${name}=`))
      ?.split(';')[0] ?? ''
  )
}
const call = (url: string, cookies = '') =>
  app.handle(new Request(url, { headers: { cookie: cookies } }))
const next = (res: Response) => res.headers.get('location')!
async function account() {
  const id = crypto.randomUUID()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'unused',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  return { id, token, cookie: `${sessionName}=${token}` }
}
async function authorize(sourceCookie = '') {
  const start = await call(
    'https://api.new.example/api/auth/domain/start?return=%2Fp%2Fshort%3Fx%3D1%23canvas',
  )
  expect(start.status).toBe(302)
  const authorized = await call(next(start), sourceCookie)
  expect(authorized.status).toBe(302)
  return { url: next(authorized), binding: cookie(start, bindingName) }
}
afterAll(async () => {
  await close()
  rmSync(directory, { recursive: true, force: true })
})
it('moves identity with a fresh HttpOnly cookie, caps expiry, preserves path and consumes once', async () => {
  const source = await account()
  const expires = Date.now() + 60000
  await db
    .update(schema.user_sessions)
    .set({ expires_at: expires })
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(source.token)))
  const flow = await authorize(source.cookie)
  const result = await call(flow.url, flow.binding)
  expect(next(result)).toBe('https://new.example/p/short?x=1&__domain_auth=done#canvas')
  const issued = cookie(result, sessionName)
  expect(issued).not.toBe(source.cookie)
  expect(issued).not.toBe('')
  const receipt = cookie(result, '__Host-image_playground_domain_complete')
  const availability = await call('https://api.new.example/api/auth/domain/available', receipt)
  expect((await availability.json()).completed).toBe(true)
  expect(result.headers.getSetCookie().find((s) => s.startsWith(sessionName))).toContain('HttpOnly')
  const token = issued.split('=')[1]!
  expect((await resolveUserSession(token))?.id).toBe(source.id)
  const [row] = await db
    .select()
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
  expect(row?.expires_at).toBe(expires)
  expect(cookie(await call(flow.url, flow.binding), sessionName)).toBe('')
  expect((await resolveUserSession(source.token))?.id).toBe(source.id)
})
it('rejects a missing binding, a wrong code, and a revoked source session', async () => {
  const source = await account()
  const flow = await authorize(source.cookie)
  expect(cookie(await call(flow.url), sessionName)).toBe('')
  const bad = new URL(flow.url)
  bad.searchParams.set('code', 'x'.repeat(43))
  expect(cookie(await call(bad.href, flow.binding), sessionName)).toBe('')
  await db
    .delete(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(source.token)))
  const result = await call(flow.url, flow.binding)
  expect(cookie(result, sessionName)).toBe('')
  expect(next(result)).toBe('https://old.example/p/short?x=1&__legacy=1#canvas')
})
it('preserves an existing destination account and lets anonymous visitors finish', async () => {
  const old = await account(),
    current = await account()
  const flow = await authorize(old.cookie)
  expect(cookie(await call(flow.url, `${flow.binding}; ${current.cookie}`), sessionName)).toBe('')
  const anon = await authorize()
  const response = await call(anon.url, anon.binding)
  expect(next(response)).toContain('https://new.example/p/short')
  expect(cookie(response, sessionName)).toBe('')
})
it('rejects open redirects and the wrong API host', async () => {
  expect(
    (
      await call(
        'https://api.new.example/api/auth/domain/start?return=https://new.example//evil.example/path',
      )
    ).status,
  ).toBe(400)
  expect(
    (await call('https://api.new.example/api/auth/domain/start?return=https://evil.example'))
      .status,
  ).toBe(400)
  expect((await call('https://api.old.example/api/auth/domain/start')).status).toBe(404)
})
it('binds the exchange to a cookie no sibling host can overwrite', async () => {
  const start = await call('https://api.new.example/api/auth/domain/start')
  const set = start.headers.getSetCookie().find((s) => s.startsWith(bindingName))!
  expect(set).toContain('HttpOnly')
  expect(set).toContain('Secure')
  expect(set).toMatch(/Path=\/(;|$)/)
  expect(set).not.toContain('Domain=')
})
it('sends a protocol-relative return path to the root instead of dead-ending', async () => {
  const start = await call('https://api.new.example/api/auth/domain/start?return=%2F%2Fp%2Fshort')
  expect(start.status).toBe(302)
  expect(next(start)).toStartWith('https://api.old.example/api/auth/domain/authorize?state=')
  const authorized = await call(next(start))
  const result = await call(next(authorized), cookie(start, bindingName))
  expect(next(result)).toBe('https://new.example/?__domain_auth=done')
})
