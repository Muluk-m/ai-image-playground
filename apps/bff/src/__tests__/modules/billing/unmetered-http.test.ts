import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import {
  accountFacts,
  creditAccounts,
  creditLedger,
  modelPrices,
  taskHolds,
  unmeteredEntitlements,
  unmeteredQuota,
} from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'
import { ensureAccount } from '../../../modules/billing/accounts'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

const databaseUrl = await resetTestDatabase('private_unmetered_http')
process.env.DATABASE_URL = databaseUrl
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'https://upstream.example.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.INTERNAL_API_TOKEN = 'fixture-private-service'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.test'
process.env.AUTH_FRONTEND_ORIGINS = 'https://paid.example.test,https://studio.example.test'
process.env.CORS_ALLOWED_ORIGINS = 'https://paid.example.test,https://studio.example.test'
process.env.OAUTH_FEISHU_CLIENT_ID = 'fixture-app-id'
process.env.OAUTH_FEISHU_CLIENT_SECRET = 'fixture-app-secret'
process.env.WELCOME_CREDITS = '2000'
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(databaseUrl)
const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { db, schema, close } = await import('../../../db/client')
const { setOAuthFetchForTesting } = await import('../../../lib/oauth')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { _setChannelsForTesting } = await import('../../../lib/channels')
const { setUpstreamFetchForTesting } = await import('../../../lib/upstream')
const { runTask } = await import('../../../workers/task-runner')
const { syncModelPricesFromChannels } = await import('../../../modules/billing/pricing')
let subject = ''
let tokenRejected = false
let profileEmail: string | undefined
const ORIGIN = 'https://studio.example.test'

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`https://api.example.test${path}`, init))
}
function cookiePair(response: Response, name: string): string {
  return (
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0]!)
      .find((cookie) => cookie.startsWith(`${name}=`)) ?? ''
  )
}
async function login(frontend = ORIGIN) {
  const start = await request(
    `/api/auth/oauth/feishu/start?frontend_origin=${encodeURIComponent(frontend)}`,
  )
  expect(start.status).toBe(302)
  const authorize = new URL(start.headers.get('location')!)
  expect(authorize.searchParams.get('client_id')).toBe('fixture-app-id')
  expect(authorize.searchParams.get('scope')).toBe(
    'contact:user.base:readonly contact:user.email:readonly',
  )
  const cookies = [
    cookiePair(start, 'image_playground_oauth_state'),
    cookiePair(start, 'image_playground_oauth_return_to'),
  ].join('; ')
  return request(
    `/api/auth/oauth/feishu/callback?code=fixture-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
    { headers: { cookie: cookies } },
  )
}
async function actor() {
  const response = await login()
  expect(response.status).toBe(302)
  expect(new URL(response.headers.get('location')!).origin).toBe(ORIGIN)
  const { USER_SESSION_COOKIE } = await import('../../../lib/user-session')
  const session = cookiePair(response, USER_SESSION_COOKIE)
  expect(session).not.toBe('')
  const [identity] = await db
    .select()
    .from(schema.user_identities)
    .where(
      and(
        eq(schema.user_identities.provider, 'feishu'),
        eq(schema.user_identities.subject, subject),
      ),
    )
  if (!identity) throw new Error('OAuth did not create the expected identity')
  return { userId: identity.user_id, cookie: session }
}
function submit(
  cookie: string,
  prompt: string,
  n = 1,
  origin = ORIGIN,
  command = crypto.randomUUID(),
  imageSize?: string,
) {
  return request('/v1/queue/openai-compat/gpt-image-2/submit', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      n,
      device_id: 'unmetered-http-device',
      client_request_id: command,
      ...(imageSize ? { image_size: imageSize } : {}),
    }),
  })
}
async function noFinancialRecords(userId: string) {
  expect(await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, userId))).toEqual(
    [],
  )
  expect(await db.select().from(taskHolds).where(eq(taskHolds.user_id, userId))).toEqual([])
  expect(await db.select().from(creditLedger).where(eq(creditLedger.user_id, userId))).toEqual([])
}
beforeEach(async () => {
  subject = `ou_${crypto.randomUUID()}`
  tokenRejected = false
  profileEmail = undefined
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([
    {
      id: 'fixture-image',
      kind: 'openai-queue',
      label: 'Fixture image',
      baseUrl: 'https://upstream.example.test',
      auth: { type: 'bearer', secretRef: 'UPSTREAM_API_KEY', secret: 'fixture-key' },
      allowedPaths: ['images/generations'],
      defaults: {},
      models: [{ id: 'gpt-image-2', label: 'Image', capabilities: ['generate'] }],
    },
  ])
  await syncModelPricesFromChannels()
  await db
    .update(modelPrices)
    .set({ credits_per_image: 100, active: true })
    .where(eq(modelPrices.model, 'gpt-image-2'))
  setOAuthFetchForTesting(
    Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/authen/v2/oauth/token')) {
          const body = JSON.parse(String(init?.body))
          expect(body.client_id).toBe('fixture-app-id')
          if (tokenRejected)
            return Response.json(
              { code: 20001, msg: 'invalid authorization code' },
              { status: 400 },
            )
          expect(body.redirect_uri).toBe('https://api.example.test/api/auth/oauth/feishu/callback')
          return Response.json({ access_token: 'fixture-user-token', token_type: 'Bearer' })
        }
        if (String(url).endsWith('/authen/v1/user_info'))
          return Response.json({
            code: 0,
            data: { open_id: subject, name: 'Member', email: profileEmail },
          })
        throw new Error('unexpected OAuth endpoint')
      },
      { preconnect: fetch.preconnect },
    ),
  )
  setUpstreamFetchForTesting(async () => Response.json({ data: [{ b64_json: 'SU1BR0U=' }] }))
})
afterAll(async () => {
  setOAuthFetchForTesting()
  setObjectStoreForTesting()
  setUpstreamFetchForTesting()
  await close()
})
it('creates a permitted identity without a wallet and returns the same account on repeated login', async () => {
  const user = await actor()
  await noFinancialRecords(user.userId)
  const again = await actor()
  expect(again.userId).toBe(user.userId)
  const account = await request('/api/billing/account', { headers: { cookie: user.cookie } })
  expect(account.status).toBe(200)
  expect(await account.json()).toMatchObject({ account: null, unmetered: { enabled: true } })
  await noFinancialRecords(user.userId)
})

it('accepts absent email and refreshes optional contact email without claiming a login address', async () => {
  const first = await actor()
  const [initial] = await db.select().from(schema.users).where(eq(schema.users.id, first.userId))
  expect(initial?.nickname).toBe('Member')
  expect(initial?.email_verified_at).toBeNull()
  profileEmail = 'Contact@Example.com'
  const second = await actor()
  expect(second.userId).toBe(first.userId)
  const [identity] = await db
    .select()
    .from(schema.user_identities)
    .where(eq(schema.user_identities.user_id, first.userId))
  const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, first.userId))
  expect(identity?.email).toBe('contact@example.com')
  expect(updated?.username).toBe(initial?.username)
  expect(updated?.username).not.toContain('@')
  expect(updated?.email_verified_at).toBeNull()
})
it('returns public model availability even after a legacy worker changes the price flag', async () => {
  const user = await actor()
  await db.update(modelPrices).set({ active: false }).where(eq(modelPrices.model, 'gpt-image-2'))
  await db
    .insert(schema.model_availability)
    .values({ model: 'gpt-image-2', active: true, updated_at: Date.now() })
    .onConflictDoUpdate({ target: schema.model_availability.model, set: { active: true } })
  const response = await request('/api/billing/account', { headers: { cookie: user.cookie } })
  expect(response.status).toBe(200)
  const snapshot = await response.json()
  expect(
    snapshot.model_prices.find((price: { model: string }) => price.model === 'gpt-image-2'),
  ).toMatchObject({ active: true })
  await noFinancialRecords(user.userId)
})

it('gates 4K before task creation and allows a Feishu entitlement without billing side effects', async () => {
  const user = await actor()
  await db.delete(accountFacts).where(eq(accountFacts.user_id, user.userId))
  await db.delete(unmeteredEntitlements).where(eq(unmeteredEntitlements.user_id, user.userId))
  const denied = await submit(
    user.cookie,
    '4K without entitlement',
    1,
    ORIGIN,
    crypto.randomUUID(),
    '4K',
  )
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ error: 'plan_required' })
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.user_id, user.userId))).toEqual(
    [],
  )
  await noFinancialRecords(user.userId)

  await db
    .insert(accountFacts)
    .values({ user_id: user.userId, category: 'feishu_unmetered', created_at: Date.now() })
  await db.insert(unmeteredEntitlements).values({ user_id: user.userId, updated_at: Date.now() })
  const allowed = await submit(
    user.cookie,
    '4K with Feishu entitlement',
    1,
    ORIGIN,
    crypto.randomUUID(),
    '4K',
  )
  expect(allowed.status).toBe(200)
  expect(
    await db.select().from(schema.tasks).where(eq(schema.tasks.user_id, user.userId)),
  ).toHaveLength(1)
  await noFinancialRecords(user.userId)
})

it('protects the Feishu identity from unlinking and preserves the account on relogin', async () => {
  const user = await actor()
  await db
    .update(schema.users)
    .set({ password_hash: await Bun.password.hash('fixture-unlink-password') })
    .where(eq(schema.users.id, user.userId))
  const unlink = await request('/api/auth/oauth/feishu/link', {
    method: 'DELETE',
    headers: { cookie: user.cookie },
  })
  expect(unlink.status).toBe(409)
  expect(await unlink.json()).toEqual({ error: 'protected_identity' })
  const again = await actor()
  expect(again.userId).toBe(user.userId)
  expect(
    await db.select().from(accountFacts).where(eq(accountFacts.user_id, user.userId)),
  ).toHaveLength(1)
  await noFinancialRecords(user.userId)
})
it('admits every identity authorized by the app without local tenant or member configuration', async () => {
  const first = await actor()
  subject = `ou_${crypto.randomUUID()}`
  const second = await actor()
  expect(second.userId).not.toBe(first.userId)
  await noFinancialRecords(first.userId)
  await noFinancialRecords(second.userId)
})
it.each([
  'missing identity',
  'rejected token',
] as const)('rejects %s before creating an account or session', async (failure) => {
  const beforeUsers = await db.select({ id: schema.users.id }).from(schema.users)
  const beforeIdentities = await db
    .select({ id: schema.user_identities.id })
    .from(schema.user_identities)
  const beforeSessions = await db
    .select({ token: schema.user_sessions.token_hash })
    .from(schema.user_sessions)
  if (failure === 'missing identity') subject = ''
  else tokenRejected = true
  const response = await login()
  expect(new URL(response.headers.get('location')!).searchParams.get('auth_error')).toBe(
    failure === 'missing identity' ? 'identity_failed' : 'exchange_failed',
  )
  expect(await db.select({ id: schema.users.id }).from(schema.users)).toEqual(beforeUsers)
  expect(await db.select({ id: schema.user_identities.id }).from(schema.user_identities)).toEqual(
    beforeIdentities,
  )
  expect(
    await db.select({ token: schema.user_sessions.token_hash }).from(schema.user_sessions),
  ).toEqual(beforeSessions)
})
it('executes unmetered generation without a price and retains its snapshot after entitlement revocation', async () => {
  const user = await actor()
  await db.delete(modelPrices).where(eq(modelPrices.model, 'gpt-image-2'))
  const response = await submit(
    user.cookie,
    'unpriced private image',
    1,
    'https://paid.example.test',
  )
  expect(response.status).toBe(200)
  const { request_id: taskId } = await response.json()
  await db
    .update(unmeteredEntitlements)
    .set({ enabled: false })
    .where(eq(unmeteredEntitlements.user_id, user.userId))
  await runTask(taskId)
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
  expect(task).toMatchObject({
    status: 'completed',
    metering: { mode: 'none' },
    user_id: user.userId,
    upstream_invocation_count: 1,
  })
  await noFinancialRecords(user.userId)
})
it('rejects an oversized first quota insert and serializes competing devices at the account quota', async () => {
  const user = await actor()
  await db
    .update(unmeteredEntitlements)
    .set({ daily_quota: 1 })
    .where(eq(unmeteredEntitlements.user_id, user.userId))
  expect((await submit(user.cookie, 'oversized first image request', 2)).status).toBe(429)
  expect(
    await db.select().from(unmeteredQuota).where(eq(unmeteredQuota.user_id, user.userId)),
  ).toEqual([])
  const responses = await Promise.all([
    submit(user.cookie, 'red image'),
    submit(user.cookie, 'blue image'),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429])
  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.user_id, user.userId))
  expect(tasks).toHaveLength(1)
  const [quota] = await db
    .select()
    .from(unmeteredQuota)
    .where(eq(unmeteredQuota.user_id, user.userId))
  expect(quota?.units).toBe(1)
  await noFinancialRecords(user.userId)
})
it('does not grant free generation when an entitlement is missing', async () => {
  const user = await actor()
  await db.delete(unmeteredEntitlements).where(eq(unmeteredEntitlements.user_id, user.userId))
  const response = await submit(user.cookie, 'missing policy must not be free')
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({
    error: 'metering_denied',
    reason: 'billing_account_unavailable',
  })
  const snapshot = await request('/api/billing/account', { headers: { cookie: user.cookie } })
  expect(snapshot.status).toBe(200)
  expect(await snapshot.json()).toMatchObject({ account: null, access_state: 'access_denied' })
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.user_id, user.userId))).toEqual(
    [],
  )
  await noFinancialRecords(user.userId)
})
