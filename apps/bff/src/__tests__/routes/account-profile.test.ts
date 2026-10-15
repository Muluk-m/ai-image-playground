import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AccountProfileView,
  type AccountSessionView,
  DEFAULT_AVATAR_PATH,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_account_profile')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'
process.env.CLIENT_IP_SOURCE = 'x-forwarded-for'
process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret-fixture'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { avatarObjectKey } = await import('../../lib/account-profile')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { setOAuthFetchForTesting } = await import('../../lib/oauth')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { USER_SESSION_COOKIE } = await import('../../lib/user-session')

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const storage = new InMemoryObjectStore()
const durable = Object.assign(new InMemoryObjectStore(), {
  sign: () => 'http://media.test/object',
})
setObjectStoreForTesting(storage)
setDurableMediaStoreForTesting(durable)

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
  body?: unknown
  bytes?: Uint8Array
  contentType?: string
  userAgent?: string
  clientAddress?: string
}

function request(path: string, call: Call = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-for': call.clientAddress ?? '203.0.113.10',
    'user-agent': call.userAgent ?? CHROME_MAC,
  }
  if (call.session) headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(call.session)}`
  let body: BodyInit | undefined
  if (call.bytes) {
    headers['content-type'] = call.contentType ?? 'application/octet-stream'
    body = Buffer.from(call.bytes)
  } else if (call.body instanceof FormData) {
    body = call.body
  } else if (call.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(call.body)
  }
  return app.handle(
    new Request(`https://api.example.com${path}`, {
      method: call.method ?? 'GET',
      headers,
      body,
    }),
  )
}

let registrations = 0

async function registerAccount(username: string, password = 'initial-secret'): Promise<string> {
  registrations += 1
  const response = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password },
    clientAddress: `10.8.0.${registrations}`,
  })
  expect(response.status).toBe(201)
  const session = readCookie(response, USER_SESSION_COOKIE)
  if (!session) throw new Error('registration issued no session')
  const profile = (await response.json()) as { user: AccountProfileView }
  expect(profile.user.avatar_is_default).toBe(true)
  expect(profile.user.avatar_url).toBe(DEFAULT_AVATAR_PATH)
  expect(profile.user.nickname).toBeNull()
  return session
}

async function pngBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer(),
  )
}

beforeEach(async () => {
  setOAuthFetchForTesting((async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'google-grant' })
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({
        sub: 'google-subject-profile',
        email: 'solo@example.com',
        email_verified: true,
        name: 'Solo',
      })
    }
    throw new Error(`unexpected upstream fetch: ${url}`)
  }) as typeof fetch)
  storage.objects.clear()
  durable.objects.clear()
  await db.delete(schema.tasks)
  await db.delete(schema.user_sessions)
  await db.delete(schema.user_identities)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
})

afterAll(async () => {
  setOAuthFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
  await closeDb()
})

describe('account profile', () => {
  it('requires a session', async () => {
    const response = await request('/api/me/profile')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns the sprout until a nickname, bio, or avatar is saved', async () => {
    const session = await registerAccount('owner@example.com')
    const response = await request('/api/me/profile', { session })
    expect(response.status).toBe(200)
    const profile = (await response.json()) as AccountProfileView
    expect(profile.username).toBe('owner@example.com')
    expect(profile.nickname).toBeNull()
    expect(profile.bio).toBeNull()
    expect(profile.avatar_is_default).toBe(true)
    expect(profile.avatar_url).toBe(DEFAULT_AVATAR_PATH)

    const me = await request('/api/auth/me', { session })
    expect(await me.json()).toEqual({ user: profile })
  })

  it('updates the nickname and bio, and rejects impersonation or an oversized bio', async () => {
    const session = await registerAccount('owner@example.com')
    const saved = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { nickname: ' 青柚工作室 ', bio: '做图的人' },
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      nickname: '青柚工作室',
      bio: '做图的人',
      avatar_is_default: true,
    })

    const blocked = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { nickname: '官方客服' },
    })
    expect(blocked.status).toBe(400)
    expect(await blocked.json()).toEqual({ error: 'nickname_blocked' })

    const spaced = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { nickname: '客 服' },
    })
    expect(spaced.status).toBe(400)
    expect(await spaced.json()).toEqual({ error: 'nickname_blocked' })

    const short = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { nickname: '芽' },
    })
    expect(short.status).toBe(400)
    expect(await short.json()).toEqual({ error: 'nickname_invalid' })

    const longBio = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { bio: '芽'.repeat(121) },
    })
    expect(longBio.status).toBe(400)
    expect(await longBio.json()).toEqual({ error: 'bio_invalid' })

    const cleared = await request('/api/me/profile', {
      method: 'PATCH',
      session,
      body: { bio: '   ' },
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ nickname: '青柚工作室', bio: null })
  })

  it('re-encodes a png, jpeg, or webp into a 512 webp and serves it', async () => {
    const session = await registerAccount('owner@example.com')
    const me = (await (await request('/api/auth/me', { session })).json()) as {
      user: { id: string }
    }
    const file = new File([Buffer.from(await pngBytes())], 'portrait.png', { type: 'image/png' })
    const form = new FormData()
    form.set('file', file)
    const uploaded = await request('/api/me/avatar', { method: 'POST', session, body: form })
    expect(uploaded.status).toBe(200)
    const profile = (await uploaded.json()) as AccountProfileView
    expect(profile.avatar_is_default).toBe(false)
    const [savedUser] = await db
      .select({ updated_at: schema.users.updated_at })
      .from(schema.users)
      .where(eq(schema.users.id, me.user.id))
    expect(profile.avatar_url).toBe(
      `/api/avatars/${encodeURIComponent(me.user.id)}?v=${savedUser?.updated_at}`,
    )

    const stored = storage.objects.get(avatarObjectKey(me.user.id))
    expect(stored?.contentType).toBe('image/webp')
    expect(await sharp(stored?.bytes).metadata()).toMatchObject({
      width: 512,
      height: 512,
      format: 'webp',
    })

    const image = await request(profile.avatar_url)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/webp')
    if (!stored) throw new Error('avatar object missing')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(stored.bytes)

    const jpeg = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aabbcc' } })
        .jpeg()
        .toBuffer(),
    )
    const jpegUpload = await request('/api/me/avatar', {
      method: 'POST',
      session,
      bytes: jpeg,
      contentType: 'image/jpeg',
    })
    expect(jpegUpload.status).toBe(200)

    const webp = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#112233' } })
        .webp()
        .toBuffer(),
    )
    const webpUpload = await request('/api/me/avatar', {
      method: 'POST',
      session,
      bytes: webp,
      contentType: 'image/webp',
    })
    expect(webpUpload.status).toBe(200)
  })

  it('rejects the wrong type, a lying content type, and a file over 5MB', async () => {
    const session = await registerAccount('owner@example.com')
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0])
    const gifUpload = await request('/api/me/avatar', {
      method: 'POST',
      session,
      bytes: gif,
      contentType: 'image/gif',
    })
    expect(gifUpload.status).toBe(400)
    expect(await gifUpload.json()).toEqual({ error: 'avatar_type' })

    const png = await pngBytes()
    const mismatch = await request('/api/me/avatar', {
      method: 'POST',
      session,
      bytes: png,
      contentType: 'image/jpeg',
    })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toEqual({ error: 'avatar_type' })

    const oversized = await request('/api/me/avatar', {
      method: 'POST',
      session,
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      contentType: 'image/png',
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'avatar_too_large' })
  })
})

describe('login devices', () => {
  it('records the user agent and address, then revokes every session except the current one', async () => {
    const username = 'devices@example.com'
    const password = 'initial-secret'
    await registerAccount(username, password)
    const older = await request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      userAgent: SAFARI_IOS,
      clientAddress: '203.0.113.20',
    })
    const olderToken = readCookie(older, USER_SESSION_COOKIE)
    const current = await request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      userAgent: CHROME_MAC,
      clientAddress: '203.0.113.30',
    })
    const currentToken = readCookie(current, USER_SESSION_COOKIE)
    if (!olderToken || !currentToken) throw new Error('login issued no session')

    const listed = await request('/api/me/sessions', {
      session: currentToken,
      userAgent: CHROME_MAC,
    })
    expect(listed.status).toBe(200)
    const { sessions } = (await listed.json()) as { sessions: AccountSessionView[] }
    expect(sessions).toHaveLength(3)
    expect(sessions.filter((session) => session.current)).toEqual([
      expect.objectContaining({
        current: true,
        user_agent: CHROME_MAC,
        device_label: 'Chrome · macOS',
        ip: '203.0.113.30',
      }),
    ])
    expect(
      sessions.some(
        (session) => session.device_label === 'Safari · iOS' && session.ip === '203.0.113.20',
      ),
    ).toBe(true)
    expect(sessions.every((session) => session.last_active_at > 0)).toBe(true)

    const revoked = await request('/api/me/sessions/revoke-others', {
      method: 'POST',
      session: currentToken,
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revoked: 2 })
    expect((await request('/api/me/profile', { session: olderToken })).status).toBe(401)
    expect((await request('/api/me/profile', { session: currentToken })).status).toBe(200)
    const remaining = await request('/api/me/sessions', { session: currentToken })
    expect(((await remaining.json()) as { sessions: AccountSessionView[] }).sessions).toHaveLength(
      1,
    )
  })
})

describe('account deletion', () => {
  it('requires the current password, then removes the user, sessions, tasks, and avatar', async () => {
    const session = await registerAccount('owner@example.com')
    const me = (await (await request('/api/auth/me', { session })).json()) as {
      user: { id: string }
    }
    await db.insert(schema.tasks).values({
      id: 'owned-task',
      provider: 'openai-compat',
      model: 'test-model',
      status: 'queued',
      request_payload: { prompt: 'bye', device_id: 'device-account-delete' },
      submitted_at: Date.now(),
      user_id: me.user.id,
    })
    await storage.write(avatarObjectKey(me.user.id), new Uint8Array([1, 2, 3]), 'image/webp')
    await durable.write(`objects/${me.user.id}/media/original`, new Uint8Array([4]), 'image/webp')
    await db
      .update(schema.users)
      .set({ avatar_key: avatarObjectKey(me.user.id) })
      .where(eq(schema.users.id, me.user.id))

    const missing = await request('/api/me', { method: 'DELETE', session, body: {} })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'current_password_required' })

    const wrong = await request('/api/me', {
      method: 'DELETE',
      session,
      body: { password: 'not-the-password' },
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'invalid_credentials' })
    expect(await db.select().from(schema.users)).toHaveLength(1)

    const deleted = await request('/api/me', {
      method: 'DELETE',
      session,
      body: { password: 'initial-secret' },
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect(deleted.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
    expect(await db.select().from(schema.users)).toHaveLength(0)
    expect(await db.select().from(schema.user_sessions)).toHaveLength(0)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(storage.objects.has(avatarObjectKey(me.user.id))).toBe(false)
    expect(durable.objects.has(`objects/${me.user.id}/media/original`)).toBe(false)
    expect((await request('/api/auth/me', { session })).status).toBe(401)
  })

  it('lets an OAuth-only account delete itself, and still refuses to unlink its only Google login', async () => {
    const start = await request('/api/auth/oauth/google/start')
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    const callback = await app.handle(
      new Request(
        `https://api.example.com/api/auth/oauth/google/callback?code=grant-code&state=${state}`,
        {
          headers: {
            cookie: `image_playground_oauth_state=${encodeURIComponent(stateCookie ?? '')}`,
            'x-forwarded-for': '203.0.113.40',
            'user-agent': CHROME_MAC,
          },
        },
      ),
    )
    const session = readCookie(callback, USER_SESSION_COOKIE)
    if (!session) throw new Error('oauth login issued no session')

    const unlink = await request('/api/auth/oauth/google/link', { method: 'DELETE', session })
    expect(unlink.status).toBe(409)
    expect(await unlink.json()).toEqual({ error: 'last_login_method' })

    const deleted = await request('/api/me', { method: 'DELETE', session, body: {} })
    expect(deleted.status).toBe(200)
    expect(await db.select().from(schema.users)).toHaveLength(0)
    expect(await db.select().from(schema.user_identities)).toHaveLength(0)
  })
})
