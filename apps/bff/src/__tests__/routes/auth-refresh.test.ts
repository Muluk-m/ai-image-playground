import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_auth_refresh')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'
process.env.CLIENT_IP_SOURCE = 'x-forwarded-for'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { log } = await import('../../lib/logger')
const {
  USER_ACCESS_TTL_MS,
  USER_REFRESH_COOKIE,
  USER_REFRESH_TTL_MS,
  USER_SESSION_ABSOLUTE_TTL_MS,
  USER_SESSION_COOKIE,
  hashSessionToken,
} = await import('../../lib/user-session')

const DAY_MS = 24 * 60 * 60 * 1000
const PASSWORD = 'correct-horse'

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

function cookieAttribute(response: Response, name: string, attribute: string): string | null {
  const header = response.headers.getSetCookie().find((raw) => raw.startsWith(`${name}=`))
  if (!header) return null
  const match = header
    .split(';')
    .find((part) => part.trim().toLowerCase().startsWith(`${attribute.toLowerCase()}=`))
  return match?.split('=').slice(1).join('=').trim() ?? null
}

let address = 1

function request(
  path: string,
  init: {
    method?: string
    access?: string | null
    refresh?: string | null
    body?: unknown
    ip?: string
    authorization?: string
    requestKey?: string
  } = {},
): Promise<Response> {
  const cookies = [
    init.access ? `${USER_SESSION_COOKIE}=${encodeURIComponent(init.access)}` : '',
    init.refresh ? `${USER_REFRESH_COOKIE}=${encodeURIComponent(init.refresh)}` : '',
  ].filter(Boolean)
  const headers: Record<string, string> = {
    'x-forwarded-for': init.ip ?? `10.8.0.${address}`,
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ')
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.authorization) headers.authorization = init.authorization
  if (init.requestKey) headers['x-session-refresh-request'] = init.requestKey
  return app.handle(
    new Request(`https://api.example.com${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  )
}

async function register(
  username: string,
): Promise<{ access: string; refresh: string; userId: string }> {
  address += 1
  const response = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password: PASSWORD },
    ip: `10.8.1.${address}`,
  })
  expect(response.status).toBe(201)
  const access = readCookie(response, USER_SESSION_COOKIE)
  const refresh = readCookie(response, USER_REFRESH_COOKIE)
  if (!access || !refresh) throw new Error('registration issued no session cookies')
  const me = await request('/api/auth/me', { access })
  expect(me.status).toBe(200)
  const body = (await me.json()) as { user: { id: string }; access_expires_at: number }
  return { access, refresh, userId: body.user.id }
}

async function refresh(access: string | null, refreshToken: string | null): Promise<Response> {
  return request('/api/auth/refresh', { method: 'POST', access, refresh: refreshToken })
}

describe('web session refresh', () => {
  it('issues a 7-day access cookie and a 30-day refresh cookie, storing only hashes', async () => {
    const before = Date.now()
    const session = await register('fresh@example.com')
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'fresh@example.com', password: PASSWORD },
      ip: '10.8.2.1',
    })
    expect(response.status).toBe(200)
    const access = readCookie(response, USER_SESSION_COOKIE)
    const refreshToken = readCookie(response, USER_REFRESH_COOKIE)
    expect(access).toBeTruthy()
    expect(refreshToken).toBeTruthy()
    expect(access).not.toBe(session.access)
    const accessCookie = response.headers
      .getSetCookie()
      .find((raw) => raw.startsWith(`${USER_SESSION_COOKIE}=`))
    const refreshCookie = response.headers
      .getSetCookie()
      .find((raw) => raw.startsWith(`${USER_REFRESH_COOKIE}=`))
    expect(accessCookie).toContain('HttpOnly')
    expect(accessCookie).toContain('Secure')
    expect(accessCookie).toContain('SameSite=Lax')
    expect(accessCookie).toContain('Path=/')
    expect(refreshCookie).toContain('HttpOnly')
    expect(refreshCookie).toContain('Secure')
    expect(refreshCookie).toContain('SameSite=Lax')
    expect(refreshCookie).toContain('Path=/api/auth')
    const accessMaxAge = Number(cookieAttribute(response, USER_SESSION_COOKIE, 'Max-Age'))
    const refreshMaxAge = Number(cookieAttribute(response, USER_REFRESH_COOKIE, 'Max-Age'))
    expect(accessMaxAge).toBeGreaterThan(USER_ACCESS_TTL_MS / 1000 - 5)
    expect(accessMaxAge).toBeLessThanOrEqual(USER_ACCESS_TTL_MS / 1000)
    expect(refreshMaxAge).toBeGreaterThan(USER_REFRESH_TTL_MS / 1000 - 5)
    expect(refreshMaxAge).toBeLessThanOrEqual(USER_REFRESH_TTL_MS / 1000)

    const [stored] = await db
      .select()
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(access!)))
    const [family] = await db
      .select()
      .from(schema.user_session_families)
      .where(eq(schema.user_session_families.id, stored!.family_id!))
    expect(stored?.token_hash).toBe(createHash('sha256').update(access!).digest('hex'))
    expect(stored?.token_hash).not.toBe(access)
    expect(family?.refresh_token_hash).toBe(hashSessionToken(refreshToken!))
    expect(family?.refresh_token_hash).not.toBe(refreshToken)
    expect(stored!.expires_at).toBeGreaterThan(before + USER_ACCESS_TTL_MS - 5_000)
    expect(stored!.expires_at).toBeLessThanOrEqual(Date.now() + USER_ACCESS_TTL_MS)
    expect(family!.refresh_expires_at - family!.created_at).toBeGreaterThan(
      USER_REFRESH_TTL_MS - 5_000,
    )
    expect(family!.absolute_expires_at - family!.created_at).toBe(USER_SESSION_ABSOLUTE_TTL_MS)
  })

  it('rotates both tokens and retires the previous refresh hash', async () => {
    const session = await register('rotate@example.com')
    const rotated = await refresh(session.access, session.refresh)
    expect(rotated.status).toBe(200)
    const nextAccess = readCookie(rotated, USER_SESSION_COOKIE)
    const nextRefresh = readCookie(rotated, USER_REFRESH_COOKIE)
    expect(nextAccess).toBeTruthy()
    expect(nextRefresh).toBeTruthy()
    expect(nextAccess).not.toBe(session.access)
    expect(nextRefresh).not.toBe(session.refresh)
    expect((await request('/api/auth/me', { access: session.access })).status).toBe(401)
    expect((await request('/api/auth/me', { access: nextAccess })).status).toBe(200)
    const [retired] = await db
      .select()
      .from(schema.user_retired_refresh_tokens)
      .where(eq(schema.user_retired_refresh_tokens.token_hash, hashSessionToken(session.refresh)))
    expect(retired).toBeDefined()
    const replay = await refresh(null, nextRefresh)
    expect(replay.status).toBe(200)
  })

  it('recovers the same rotation after its response was lost beyond the reuse grace period', async () => {
    const session = await register('lost-rotation-response@example.com')
    const requestKey = '7cbcb24c-5b41-40a1-9c35-3e909f907b79'
    const input = {
      method: 'POST',
      access: session.access,
      refresh: session.refresh,
      requestKey,
    }
    const discarded = await request('/api/auth/refresh', input)
    expect(discarded.status).toBe(200)
    await db
      .update(schema.user_retired_refresh_tokens)
      .set({ retired_at: Date.now() - 60_000 })
      .where(eq(schema.user_retired_refresh_tokens.token_hash, hashSessionToken(session.refresh)))
    const retried = await request('/api/auth/refresh', input)
    expect(retried.status).toBe(200)
    expect(readCookie(retried, USER_REFRESH_COOKIE)).toBe(
      readCookie(discarded, USER_REFRESH_COOKIE),
    )
    expect(readCookie(retried, USER_SESSION_COOKIE)).toBe(
      readCookie(discarded, USER_SESSION_COOKIE),
    )
    expect(
      (await request('/api/auth/me', { access: readCookie(retried, USER_SESSION_COOKIE) })).status,
    ).toBe(200)
  })

  it('does not rotate again if cookies arrived but acknowledgement was lost', async () => {
    const session = await register('lost-body@example.com')
    const requestKey = '0fa4bc51-c6fe-4c89-b598-31f065ead81f'
    const first = await request('/api/auth/refresh', {
      method: 'POST',
      refresh: session.refresh,
      requestKey,
    })
    const nextRefresh = readCookie(first, USER_REFRESH_COOKIE)
    const nextAccess = readCookie(first, USER_SESSION_COOKIE)
    const again = await request('/api/auth/refresh', {
      method: 'POST',
      refresh: nextRefresh,
      requestKey,
    })
    expect(again.status).toBe(200)
    expect(readCookie(again, USER_REFRESH_COOKIE)).toBe(nextRefresh)
    expect(readCookie(again, USER_SESSION_COOKIE)).toBe(nextAccess)
    expect(await again.json()).toEqual(await first.json())
  })

  it('recovers refresh with the original expired access lifetime after access cleanup', async () => {
    const session = await register('expired-recovery@example.com')
    const requestKey = '818099e9-4d87-44fc-b3a4-05183da6c8a4'
    const first = await request('/api/auth/refresh', {
      method: 'POST',
      refresh: session.refresh,
      requestKey,
    })
    const nextRefresh = readCookie(first, USER_REFRESH_COOKIE)!
    const [family] = await db
      .select()
      .from(schema.user_session_families)
      .where(eq(schema.user_session_families.refresh_token_hash, hashSessionToken(nextRefresh)))
    await db
      .update(schema.user_session_families)
      .set({ refreshed_at: Date.now() - 8 * DAY_MS })
      .where(eq(schema.user_session_families.id, family!.id))
    await db.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, family!.id))
    const recovered = await request('/api/auth/refresh', {
      method: 'POST',
      refresh: session.refresh,
      requestKey,
    })
    expect(recovered.status).toBe(200)
    expect(readCookie(recovered, USER_REFRESH_COOKIE)).toBe(nextRefresh)
    expect(Number(cookieAttribute(recovered, USER_SESSION_COOKIE, 'Max-Age'))).toBe(0)
    const renewed = await request('/api/auth/refresh', {
      method: 'POST',
      refresh: nextRefresh,
      requestKey: '675339f8-cd14-4176-8b7f-239f102b501a',
    })
    expect(renewed.status).toBe(200)
    expect(
      (await request('/api/auth/me', { access: readCookie(renewed, USER_SESSION_COOKIE) })).status,
    ).toBe(200)
  })

  it('rejects a wrong proof, preserves the healthy family, and refuses exact recovery after logout', async () => {
    const session = await register('proof-security@example.com')
    const input = {
      method: 'POST',
      refresh: session.refresh,
      requestKey: '65e35692-9c32-45b6-8db2-b9ebc084818d',
    }
    const first = await request('/api/auth/refresh', input)
    const access = readCookie(first, USER_SESSION_COOKIE)
    await db
      .update(schema.user_retired_refresh_tokens)
      .set({ retired_at: Date.now() - 60_000 })
      .where(eq(schema.user_retired_refresh_tokens.token_hash, hashSessionToken(session.refresh)))
    const wrong = await request('/api/auth/refresh', {
      ...input,
      requestKey: '2b9f78c6-974b-45cc-b3af-a9759ad4335c',
    })
    expect(wrong.status).toBe(401)
    expect((await request('/api/auth/me', { access })).status).toBe(200)
    await request('/api/auth/logout', {
      method: 'POST',
      refresh: readCookie(first, USER_REFRESH_COOKIE),
      access,
    })
    expect((await request('/api/auth/refresh', input)).status).toBe(401)
  })

  it('converges concurrent retries on the identical pair and does not slide their expiry', async () => {
    const session = await register('concurrent-proof@example.com')
    const input = {
      method: 'POST',
      refresh: session.refresh,
      requestKey: 'f4708019-049a-48b2-a0c5-4eb007ee341e',
    }
    const [first, second] = await Promise.all([
      request('/api/auth/refresh', input),
      request('/api/auth/refresh', input),
    ])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(readCookie(second, USER_REFRESH_COOKIE)).toBe(readCookie(first, USER_REFRESH_COOKIE))
    expect(readCookie(second, USER_SESSION_COOKIE)).toBe(readCookie(first, USER_SESSION_COOKIE))
    expect(await second.json()).toEqual(await first.json())
  })

  it('cannot recover a disabled account, including after the account is re-enabled', async () => {
    const session = await register('disabled-proof@example.com')
    const input = {
      method: 'POST',
      refresh: session.refresh,
      requestKey: 'd8650ab9-40c0-435d-8537-bc56ab1d44ad',
    }
    await request('/api/auth/refresh', input)
    await db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, session.userId))
    expect((await request('/api/auth/refresh', input)).status).toBe(401)
    await db
      .update(schema.users)
      .set({ status: 'active' })
      .where(eq(schema.users.id, session.userId))
    expect((await request('/api/auth/refresh', input)).status).toBe(401)
  })

  it('does not execute a completed request key again against a newer cookie generation', async () => {
    const session = await register('paused-tab@example.com')
    const key1 = '3b999810-7feb-4f91-988d-7006d8b78932'
    const key2 = '4d1b085f-38c8-4b3d-9b36-f650b9324735'
    const first = await request('/api/auth/refresh', { method: 'POST', refresh: session.refresh, requestKey: key1 })
    const second = await request('/api/auth/refresh', { method: 'POST', refresh: readCookie(first, USER_REFRESH_COOKIE), requestKey: key2 })
    const secondRefresh = readCookie(second, USER_REFRESH_COOKIE)
    const stale = await request('/api/auth/refresh', { method: 'POST', refresh: secondRefresh, requestKey: key1 })
    expect(stale.status).toBe(409)
    expect(stale.headers.getSetCookie()).toHaveLength(0)
    expect((await request('/api/auth/me', { access: readCookie(second, USER_SESSION_COOKIE) })).status).toBe(200)
    const retry = await request('/api/auth/refresh', { method: 'POST', refresh: readCookie(first, USER_REFRESH_COOKIE), requestKey: key2 })
    expect(retry.status).toBe(200)
    expect(readCookie(retry, USER_REFRESH_COOKIE)).toBe(secondRefresh)
  })

  it('validates the refresh proof before changing session state', async () => {
    const session = await register('invalid-proof@example.com')
    expect(
      (
        await request('/api/auth/refresh', {
          method: 'POST',
          refresh: session.refresh,
          requestKey: 'not-a-key',
        })
      ).status,
    ).toBe(400)
    expect((await request('/api/auth/me', { access: session.access })).status).toBe(200)
  })

  it('treats a retired refresh inside the grace window as a race and keeps the family', async () => {
    const session = await register('grace@example.com')
    const rotated = await refresh(session.access, session.refresh)
    const nextAccess = readCookie(rotated, USER_SESSION_COOKIE)!
    const raced = await refresh(null, session.refresh)
    expect(raced.status).toBe(409)
    expect(await raced.json()).toEqual({ error: 'refresh_raced' })
    expect((await request('/api/auth/me', { access: nextAccess })).status).toBe(200)
    const [family] = await db
      .select({ revoked_at: schema.user_session_families.revoked_at })
      .from(schema.user_session_families)
      .innerJoin(
        schema.user_sessions,
        eq(schema.user_sessions.family_id, schema.user_session_families.id),
      )
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(nextAccess)))
    expect(family?.revoked_at).toBeNull()
  })

  it('rejects an unproven retired refresh without revoking a healthy family', async () => {
    const session = await register('reuse@example.com')
    const rotated = await refresh(session.access, session.refresh)
    const nextAccess = readCookie(rotated, USER_SESSION_COOKIE)!
    await db
      .update(schema.user_retired_refresh_tokens)
      .set({ retired_at: Date.now() - 40 * DAY_MS })
      .where(eq(schema.user_retired_refresh_tokens.token_hash, hashSessionToken(session.refresh)))
    const warnings: unknown[] = []
    const original = log.warn
    log.warn = ((first: unknown) => {
      warnings.push(first)
    }) as typeof log.warn
    try {
      const replay = await refresh(null, session.refresh)
      expect(replay.status).toBe(401)
      expect(await replay.json()).toEqual({ error: 'unauthorized' })
    } finally {
      log.warn = original
    }
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: 'auth.refresh.retired_rejected' }),
    )
    expect((await request('/api/auth/me', { access: nextAccess })).status).toBe(200)
    expect((await refresh(null, readCookie(rotated, USER_REFRESH_COOKIE))).status).toBe(200)
  })

  it('slides the refresh window forward and stops at the absolute cap', async () => {
    const session = await register('slide@example.com')
    const [before] = await db
      .select()
      .from(schema.user_session_families)
      .innerJoin(
        schema.user_sessions,
        eq(schema.user_sessions.family_id, schema.user_session_families.id),
      )
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(session.access)))
    const familyId = before!.user_session_families.id
    const now = Date.now()
    await db
      .update(schema.user_session_families)
      .set({ refresh_expires_at: now + DAY_MS, refreshed_at: now - 20 * DAY_MS })
      .where(eq(schema.user_session_families.id, familyId))
    const slid = await refresh(session.access, session.refresh)
    expect(slid.status).toBe(200)
    const [afterSlide] = await db
      .select()
      .from(schema.user_session_families)
      .where(eq(schema.user_session_families.id, familyId))
    expect(afterSlide!.refresh_expires_at).toBeGreaterThan(now + USER_REFRESH_TTL_MS - 5_000)
    expect(afterSlide!.absolute_expires_at).toBe(before!.user_session_families.absolute_expires_at)

    const createdAt = now - 80 * DAY_MS
    const absolute = createdAt + USER_SESSION_ABSOLUTE_TTL_MS
    await db
      .update(schema.user_session_families)
      .set({
        created_at: createdAt,
        absolute_expires_at: absolute,
        refresh_expires_at: absolute,
      })
      .where(eq(schema.user_session_families.id, familyId))
    const capped = await refresh(
      readCookie(slid, USER_SESSION_COOKIE),
      readCookie(slid, USER_REFRESH_COOKIE),
    )
    expect(capped.status).toBe(200)
    const [afterCap] = await db
      .select()
      .from(schema.user_session_families)
      .where(eq(schema.user_session_families.id, familyId))
    expect(afterCap!.refresh_expires_at).toBe(absolute)
    expect(afterCap!.absolute_expires_at).toBe(absolute)
    const [access] = await db
      .select({ expires_at: schema.user_sessions.expires_at })
      .from(schema.user_sessions)
      .where(
        eq(
          schema.user_sessions.token_hash,
          hashSessionToken(readCookie(capped, USER_SESSION_COOKIE)!),
        ),
      )
    expect(access!.expires_at).toBeLessThanOrEqual(absolute)
    expect(access!.expires_at).toBeGreaterThan(now + USER_ACCESS_TTL_MS - 5_000)

    await db
      .update(schema.user_session_families)
      .set({ absolute_expires_at: now - 1_000, refresh_expires_at: now + DAY_MS })
      .where(eq(schema.user_session_families.id, familyId))
    const expired = await refresh(
      readCookie(capped, USER_SESSION_COOKIE),
      readCookie(capped, USER_REFRESH_COOKIE),
    )
    expect(expired.status).toBe(401)
    expect(
      (await request('/api/auth/me', { access: readCookie(capped, USER_SESSION_COOKIE) })).status,
    ).toBe(401)
  })

  it('revokes every refresh on logout and on an admin password reset', async () => {
    const loggedOut = await register('logout@example.com')
    const goodbye = await request('/api/auth/logout', { method: 'POST', access: loggedOut.access })
    expect(goodbye.status).toBe(200)
    expect(
      goodbye.headers.getSetCookie().some((raw) => raw.startsWith(`${USER_REFRESH_COOKIE}=`)),
    ).toBe(true)
    expect((await refresh(loggedOut.access, loggedOut.refresh)).status).toBe(401)
    expect((await request('/api/auth/me', { access: loggedOut.access })).status).toBe(401)

    const accessGone = await register('logout-refresh@example.com')
    await db
      .delete(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(accessGone.access)))
    const cleared = await request('/api/auth/logout', {
      method: 'POST',
      refresh: accessGone.refresh,
    })
    expect(cleared.status).toBe(200)
    expect((await refresh(null, accessGone.refresh)).status).toBe(401)

    const reset = await register('reset@example.com')
    const admin = await request(`/internal/admin/users/${reset.userId}/reset-password`, {
      method: 'POST',
      authorization: 'Bearer fixture-service-credential-alpha',
      body: { password: 'replacement-secret' },
    })
    expect(admin.status).toBe(200)
    expect((await refresh(reset.access, reset.refresh)).status).toBe(401)
    expect((await request('/api/auth/me', { access: reset.access })).status).toBe(401)
  })

  it('revokes other devices on password change and rotates the current refresh', async () => {
    const first = await register('password@example.com')
    address += 1
    const secondLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'password@example.com', password: PASSWORD },
      ip: `10.8.3.${address}`,
    })
    const second = {
      access: readCookie(secondLogin, USER_SESSION_COOKIE)!,
      refresh: readCookie(secondLogin, USER_REFRESH_COOKIE)!,
    }
    const changed = await request('/api/auth/password', {
      method: 'POST',
      access: first.access,
      refresh: first.refresh,
      body: { current_password: PASSWORD, new_password: 'replacement-secret' },
    })
    expect(changed.status).toBe(200)
    const rotatedRefresh = readCookie(changed, USER_REFRESH_COOKIE)
    expect(rotatedRefresh).toBeTruthy()
    expect(rotatedRefresh).not.toBe(first.refresh)
    expect((await request('/api/auth/me', { access: first.access })).status).toBe(200)
    expect((await request('/api/auth/me', { access: second.access })).status).toBe(401)
    expect((await refresh(null, second.refresh)).status).toBe(401)
    const raced = await refresh(first.access, first.refresh)
    expect(raced.status).toBe(409)
    expect((await refresh(first.access, rotatedRefresh)).status).toBe(200)
  })

  it('keeps a legacy session usable and upgrades it on refresh without forcing a logout', async () => {
    const now = Date.now()
    const createdAt = now - 10 * DAY_MS
    await db.insert(schema.users).values({
      id: 'legacy-user',
      username: 'legacy@example.com',
      password_hash: 'not-a-login',
      status: 'active',
      created_at: createdAt,
      updated_at: now,
    })
    const legacyToken = 'legacy-access-token-value'
    await db.insert(schema.user_sessions).values({
      token_hash: hashSessionToken(legacyToken),
      user_id: 'legacy-user',
      created_at: createdAt,
      expires_at: now + 20 * DAY_MS,
      last_active_at: now,
    })
    expect((await request('/api/auth/me', { access: legacyToken })).status).toBe(200)

    const upgraded = await refresh(legacyToken, null)
    expect(upgraded.status).toBe(200)
    const access = readCookie(upgraded, USER_SESSION_COOKIE)
    const refreshToken = readCookie(upgraded, USER_REFRESH_COOKIE)
    expect(access).toBeTruthy()
    expect(refreshToken).toBeTruthy()
    expect((await request('/api/auth/me', { access: legacyToken })).status).toBe(401)
    expect((await request('/api/auth/me', { access })).status).toBe(200)
    const [family] = await db
      .select()
      .from(schema.user_session_families)
      .where(eq(schema.user_session_families.user_id, 'legacy-user'))
    expect(family?.created_at).toBe(createdAt)
    expect(family!.absolute_expires_at - createdAt).toBe(USER_SESSION_ABSOLUTE_TTL_MS)
    expect(family!.refresh_token_hash).toBe(hashSessionToken(refreshToken!))
    const again = await refresh(access, refreshToken)
    expect(again.status).toBe(200)
    await db
      .update(schema.user_retired_refresh_tokens)
      .set({ retired_at: Date.now() - 60_000 })
      .where(eq(schema.user_retired_refresh_tokens.token_hash, hashSessionToken(legacyToken)))
    const warnings: unknown[] = []
    const original = log.warn
    log.warn = ((first: unknown) => {
      warnings.push(first)
    }) as typeof log.warn
    try {
      const replay = await refresh(legacyToken, null)
      expect(replay.status).toBe(401)
    } finally {
      log.warn = original
    }
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: 'auth.refresh.retired_rejected' }),
    )
    expect(
      (await request('/api/auth/me', { access: readCookie(again, USER_SESSION_COOKIE) })).status,
    ).toBe(200)
  })
})

afterAll(async () => {
  await closeDb()
})
