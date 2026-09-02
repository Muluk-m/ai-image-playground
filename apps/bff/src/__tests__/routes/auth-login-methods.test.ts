import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { LoginMethodsView } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_login_methods')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'
// Registration is rate limited per client address; every fixture account claims its own.
process.env.CLIENT_IP_SOURCE = 'x-forwarded-for'

// The app reads its config at module load, so the env above must be in place first.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setOAuthFetchForTesting } = await import('../../lib/oauth')
const { USER_SESSION_COOKIE } = await import('../../lib/user-session')

const STATE_COOKIE = 'image_playground_oauth_state'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

function stubGoogle(profile: Record<string, unknown>): void {
  setOAuthFetchForTesting((async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'google-grant' })
    if (url === GOOGLE_USERINFO_ENDPOINT) return Response.json(profile)
    throw new Error(`unexpected upstream fetch: ${url}`)
  }) as typeof fetch)
}

function readCookie(response: Response, name: string): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (pair && separator > 0 && pair.slice(0, separator) === name) {
      return decodeURIComponent(pair.slice(separator + 1))
    }
  }
  return null
}

interface Call {
  method?: string
  session?: string | null
  state?: string | null
  body?: unknown
  clientAddress?: string
}

function request(path: string, call: Call = {}): Promise<Response> {
  const cookies = [
    call.session ? `${USER_SESSION_COOKIE}=${encodeURIComponent(call.session)}` : '',
    call.state ? `${STATE_COOKIE}=${encodeURIComponent(call.state)}` : '',
  ].filter(Boolean)
  const headers: Record<string, string> = { 'x-forwarded-for': call.clientAddress ?? '10.0.0.1' }
  if (cookies.length > 0) headers.cookie = cookies.join('; ')
  if (call.body !== undefined) headers['content-type'] = 'application/json'
  return app.handle(
    new Request(`https://api.example.com${path}`, {
      method: call.method ?? 'GET',
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    }),
  )
}

let registrations = 0

async function registerAccount(username: string, password: string): Promise<string> {
  registrations += 1
  const response = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password },
    clientAddress: `10.1.0.${registrations}`,
  })
  expect(response.status).toBe(201)
  const session = readCookie(response, USER_SESSION_COOKIE)
  if (!session) throw new Error('registration issued no session')
  return session
}

async function loginAccount(username: string, password: string): Promise<Response> {
  return request('/api/auth/login', { method: 'POST', body: { username, password } })
}

/** Returns the state cookie, whose trailing segment is the state the callback must echo. */
async function startFlow(kind: 'start' | 'link', session?: string): Promise<string> {
  const response = await request(`/api/auth/oauth/google/${kind}`, { session })
  expect(response.status).toBe(302)
  const state = new URL(response.headers.get('location') ?? '').searchParams.get('state')
  const cookie = readCookie(response, STATE_COOKIE)
  if (!state || !cookie) throw new Error(`${kind} issued no state`)
  // A link state also carries the account that started it, so only its prefix is fixed.
  if (kind === 'link') expect(cookie.startsWith('google:link:')).toBe(true)
  else expect(cookie).toBe(`google:login:${state}`)
  return cookie
}

function callback(stateCookie: string, session?: string | null): Promise<Response> {
  const state = stateCookie.slice(stateCookie.lastIndexOf(':') + 1)
  return request(`/api/auth/oauth/google/callback?code=grant-code&state=${state}`, {
    session,
    state: stateCookie,
  })
}

async function loginMethods(session: string): Promise<LoginMethodsView> {
  const response = await request('/api/auth/login-methods', { session })
  expect(response.status).toBe(200)
  return (await response.json()) as LoginMethodsView
}

/** Signs in a fresh Google subject, which provisions the OAuth-only account. */
async function oauthOnlyAccount(subject: string, email: string): Promise<string> {
  stubGoogle({ sub: subject, email, email_verified: true, name: 'Creator' })
  const response = await callback(await startFlow('start'))
  expect(response.headers.get('location')).toBe('https://app.example.com/')
  const session = readCookie(response, USER_SESSION_COOKIE)
  if (!session) throw new Error('oauth login issued no session')
  return session
}

beforeEach(async () => {
  process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret-fixture'
  setOAuthFetchForTesting()
  await db.delete(schema.user_sessions)
  await db.delete(schema.user_identities)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
})

afterAll(async () => {
  setOAuthFetchForTesting()
  await closeDb()
})

describe('login methods', () => {
  it('refuses to describe login methods without a session', async () => {
    const response = await request('/api/auth/login-methods')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('reports a password and no identity for an email account', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    expect(await loginMethods(session)).toEqual({ password: true, identities: [] })
  })

  it('reports the identity and no password for an OAuth-only account', async () => {
    const session = await oauthOnlyAccount('google-subject-1', 'creator@example.com')
    const methods = await loginMethods(session)
    expect(methods.password).toBe(false)
    expect(methods.identities).toHaveLength(1)
    expect(methods.identities[0]?.provider).toBe('google')
    expect(methods.identities[0]?.email).toBe('creator@example.com')
  })
})

describe('self-service password', () => {
  it('lets an OAuth-only account set a first password and keeps its session', async () => {
    const session = await oauthOnlyAccount('google-subject-2', 'first@example.com')
    const response = await request('/api/auth/password', {
      method: 'POST',
      session,
      body: { new_password: 'brand-new-secret' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect((await loginMethods(session)).password).toBe(true)
    expect((await loginAccount('first@example.com', 'brand-new-secret')).status).toBe(200)
  })

  it('requires the current password once one exists', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    const missing = await request('/api/auth/password', {
      method: 'POST',
      session,
      body: { new_password: 'replacement-secret' },
    })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'current_password_required' })

    const wrong = await request('/api/auth/password', {
      method: 'POST',
      session,
      body: { current_password: 'not-the-password', new_password: 'replacement-secret' },
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'invalid_credentials' })
    expect((await loginAccount('owner@example.com', 'initial-secret')).status).toBe(200)
  })

  it('rejects a new password that is too short', async () => {
    const session = await oauthOnlyAccount('google-subject-3', 'short@example.com')
    const response = await request('/api/auth/password', {
      method: 'POST',
      session,
      body: { new_password: 'short' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_password' })
  })

  it('revokes every other session but the caller own', async () => {
    const keep = await registerAccount('owner@example.com', 'initial-secret')
    const other = readCookie(
      await loginAccount('owner@example.com', 'initial-secret'),
      USER_SESSION_COOKIE,
    )
    expect(other).toBeTruthy()

    const response = await request('/api/auth/password', {
      method: 'POST',
      session: keep,
      body: { current_password: 'initial-secret', new_password: 'replacement-secret' },
    })
    expect(response.status).toBe(200)

    expect((await request('/api/auth/login-methods', { session: keep })).status).toBe(200)
    expect((await request('/api/auth/login-methods', { session: other })).status).toBe(401)
    expect((await loginAccount('owner@example.com', 'replacement-secret')).status).toBe(200)
    expect((await loginAccount('owner@example.com', 'initial-secret')).status).toBe(401)
  })
})

describe('identity linking', () => {
  it('refuses to start a link without a session', async () => {
    const response = await request('/api/auth/oauth/google/link')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('attaches a provider to the account that started the flow', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    const stateCookie = await startFlow('link', session)
    stubGoogle({ sub: 'google-subject-4', email: 'Owner@Example.com', email_verified: true })

    const response = await callback(stateCookie, session)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://app.example.com/?auth_link=google')
    // A link must never mint a session; the caller is already signed in.
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeNull()

    const methods = await loginMethods(session)
    expect(methods).toEqual({
      password: true,
      identities: [
        { provider: 'google', email: 'owner@example.com', linked_at: expect.any(Number) },
      ],
    })
    expect(await db.select().from(schema.users)).toHaveLength(1)

    const [user] = await db.select().from(schema.users)
    const [audit] = await db
      .select()
      .from(schema.operator_audits)
      .where(
        and(
          eq(schema.operator_audits.action, 'user.identity.link'),
          eq(schema.operator_audits.target_id, user?.id ?? ''),
        ),
      )
    expect(audit?.operator_id).toBe(user?.id ?? '')
  })

  it('refuses a subject that already belongs to another account', async () => {
    await oauthOnlyAccount('google-subject-5', 'holder@example.com')
    const session = await registerAccount('other@example.com', 'initial-secret')
    const stateCookie = await startFlow('link', session)
    stubGoogle({ sub: 'google-subject-5', email: 'holder@example.com', email_verified: true })

    const response = await callback(stateCookie, session)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_link_error=identity_taken',
    )
    expect((await loginMethods(session)).identities).toEqual([])
    expect(await db.select().from(schema.user_identities)).toHaveLength(1)
  })

  it('reports an expired session instead of provisioning an account', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    const stateCookie = await startFlow('link', session)
    await request('/api/auth/logout', { method: 'POST', session })
    stubGoogle({ sub: 'google-subject-6', email: 'ghost@example.com', email_verified: true })

    const response = await callback(stateCookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_link_error=unauthenticated',
    )
    expect(await db.select().from(schema.user_identities)).toHaveLength(0)
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('refuses to land the identity on an account that did not start the link', async () => {
    const starter = await registerAccount('starter@example.com', 'initial-secret')
    const stateCookie = await startFlow('link', starter)
    const switched = await registerAccount('switched@example.com', 'initial-secret')
    stubGoogle({ sub: 'google-subject-10', email: 'drifter@example.com', email_verified: true })

    const response = await callback(stateCookie, switched)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_link_error=unauthenticated',
    )
    expect(await db.select().from(schema.user_identities)).toHaveLength(0)
  })

  it('reports a denial through the link parameter', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    const stateCookie = await startFlow('link', session)
    const state = stateCookie.slice(stateCookie.lastIndexOf(':') + 1)

    const response = await request(
      `/api/auth/oauth/google/callback?error=access_denied&state=${state}`,
      { session, state: stateCookie },
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_link_error=access_denied',
    )
  })

  it('keeps a login-mode callback signing in rather than linking', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    stubGoogle({ sub: 'google-subject-7', email: 'separate@example.com', email_verified: true })

    // The mode lives in the state cookie, so a login flow finished by a signed-in browser
    // provisions its own account instead of silently joining the open session.
    const response = await callback(await startFlow('start'), session)
    expect(response.headers.get('location')).toBe('https://app.example.com/')
    expect((await loginMethods(session)).identities).toEqual([])
    expect(await db.select().from(schema.users)).toHaveLength(2)
  })
})

describe('identity unlinking', () => {
  it('keeps the last login method', async () => {
    const session = await oauthOnlyAccount('google-subject-8', 'solo@example.com')
    const response = await request('/api/auth/oauth/google/link', { method: 'DELETE', session })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'last_login_method' })
    expect(await db.select().from(schema.user_identities)).toHaveLength(1)
  })

  it('detaches a provider once a password can take over', async () => {
    const session = await oauthOnlyAccount('google-subject-9', 'movingon@example.com')
    await request('/api/auth/password', {
      method: 'POST',
      session,
      body: { new_password: 'brand-new-secret' },
    })

    const response = await request('/api/auth/oauth/google/link', { method: 'DELETE', session })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect((await loginMethods(session)).identities).toEqual([])
    expect((await loginAccount('movingon@example.com', 'brand-new-secret')).status).toBe(200)
  })

  it('reports a provider that was never linked', async () => {
    const session = await registerAccount('owner@example.com', 'initial-secret')
    const response = await request('/api/auth/oauth/google/link', { method: 'DELETE', session })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_linked' })
  })

  it('refuses to unlink without a session', async () => {
    const response = await request('/api/auth/oauth/google/link', { method: 'DELETE' })
    expect(response.status).toBe(401)
  })
})
