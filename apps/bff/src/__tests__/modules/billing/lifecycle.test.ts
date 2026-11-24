import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resolve } from 'node:path'
import {
  creditAccounts,
  creditLedger,
  modelPrices,
  plans,
  subscriptions,
  taskHolds,
} from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  MAX_CREDIT_BALANCE,
  type VideoRequest,
  videoRateMultiplier,
} from '@image-playground/shared'
import { SQL } from 'bun'
import { eq, sql } from 'drizzle-orm'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('billing_lifecycle')
const SERVICE_CREDENTIAL = 'fixture-service-credential-alpha'
const LOGIN_PHRASE = 'fixture-login-phrase-alpha'
const WELCOME = 2_000

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = SERVICE_CREDENTIAL
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
process.env.WELCOME_CREDITS = String(WELCOME)
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { setAsyncPollBackoffForTesting, setUpstreamFetchForTesting } = await import(
  '../../../lib/upstream'
)
const { _setChannelsForTesting } = await import('../../../lib/channels')
const { scanDueAccounts } = await import('../../../modules/billing/entitlement')
const { privateTaskHooks } = await import('../../../modules/billing/hooks')
const { syncModelPricesFromChannels } = await import('../../../modules/billing/pricing')
const { runTask } = await import('../../../workers/task-runner')
const { recoverTasksByIds, purgeOldTasks } = await import('../../../db/maintenance')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>
interface BillingLedgerEntry {
  bucket: string
  entry_type: string
  amount: number
  task_id: string | null
  reference_id: string | null
  note: string | null
  metadata: Record<string, unknown>
}

interface TestJson {
  request_id?: string
  error?: string
  required?: number
  available?: number
  account?: {
    subscription_balance: number
    recharge_balance: number
    subscription_expires_at: number | null
  }
  ledger?: BillingLedgerEntry[]
  subscription_id?: string
  plans?: Array<{
    id: string
    active: boolean
    prices: Array<{ period_months: number }>
  }>
  next_offset?: number | null
  settings?: {
    contact_wechat: string
    payment_qr_url: string
    contact_qr_url: string
    guidance: string
  } | null
}

function requestId(result: { json: TestJson }): string {
  if (!result.json.request_id) throw new Error('response did not contain request_id')
  return result.json.request_id
}
function subscriptionId(result: { json: TestJson }): string {
  if (!result.json.subscription_id) throw new Error('response did not contain subscription_id')
  return result.json.subscription_id
}

function accountState(result: { json: TestJson }) {
  if (!result.json.account || !result.json.ledger) {
    throw new Error('response did not contain billing account state')
  }
  return { account: result.json.account, ledger: result.json.ledger }
}

function ledgerPage(result: { json: TestJson }) {
  if (!result.json.ledger) throw new Error('response did not contain a billing ledger page')
  return { ledger: result.json.ledger, next_offset: result.json.next_offset ?? null }
}

let storage: InMemoryObjectStore

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: TestJson; headers: Headers }> {
  const requestHeaders = { ...headers }
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json = (await response.json()) as TestJson
  return { status: response.status, json, headers: response.headers }
}

async function waitForBlockedUserInserts(observer: SQL, expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    const [state] = await observer`
      SELECT COUNT(*)::int AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%insert into "users"%'
    `
    if ((state?.blocked ?? 0) >= expectedCount) return
  }
  throw new Error('registrations did not reach the blocked user inserts')
}

async function resetDb(): Promise<void> {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(subscriptions)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
  await db.delete(schema.user_sessions)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
  await db
    .update(modelPrices)
    .set({ credits_per_image: 100, active: true, updated_at: Date.now() })
    .where(eq(modelPrices.model, 'gpt-image-2'))
}

async function findUserId(username = 'billing-user'): Promise<string> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1)
  if (!user) throw new Error(`test user not found: ${username}`)
  return user.id
}

async function createAndLogin(username = 'billing-user'): Promise<string> {
  const created = await jsonReq(
    'POST',
    '/internal/admin/users',
    { username, password: LOGIN_PHRASE },
    { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
  )
  expect(created.status).toBe(201)
  const login = await jsonReq('POST', '/api/auth/login', {
    username,
    password: LOGIN_PHRASE,
  })
  expect(login.status).toBe(200)
  return login.headers.get('set-cookie')!.split(';')[0]!
}

/** ISO-BMFF 头：4 字节 box size + 'ftyp'。 */
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])
const GROK_VIDEO_BASE = 'https://gateway.example/v1'

function videoSubmission(): { video: VideoRequest } {
  return { video: { duration_seconds: 8, aspect_ratio: '16:9', resolution: '1080p' } }
}

/** 每秒 80 积分的 Grok 视频频道：8 秒 1080p 应预扣 ceil(80 × 8 × 1.6) = 1024。 */
async function usePerSecondVideoChannel(): Promise<string> {
  const cookie = await createAndLogin()
  const now = Date.now()
  await db
    .insert(modelPrices)
    .values({
      model: 'grok-imagine-video',
      credits_per_image: 80,
      unit: 'second',
      active: true,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: modelPrices.model,
      set: { credits_per_image: 80, unit: 'second', active: true, updated_at: now },
    })
  _setChannelsForTesting([
    {
      id: 'grok-video',
      kind: 'openai-queue',
      label: 'Grok Imagine Video',
      baseUrl: GROK_VIDEO_BASE,
      auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'fixture-key' },
      allowedPaths: ['videos/generations', 'videos'],
      models: [
        {
          id: 'grok-imagine-video',
          label: 'Grok Imagine Video',
          media: 'video',
          capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
        },
      ],
      defaults: { timeout: 600, asyncTasks: true },
    },
  ])
  return cookie
}

function stubGrokVideo(content: () => Response): void {
  setAsyncPollBackoffForTesting([1])
  setUpstreamFetchForTesting(
    mock(async (input: unknown) => {
      const url = String(input)
      if (url === `${GROK_VIDEO_BASE}/videos/generations`)
        return Response.json({ request_id: 'v1' })
      if (url === `${GROK_VIDEO_BASE}/videos/v1`) {
        return Response.json({
          status: 'done',
          video: { duration: 8, url: '/v1/videos/v1/content' },
        })
      }
      return content()
    }) as unknown as TestFetch,
  )
}

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a lighthouse in rain',
    n: 1,
    device_id: 'billing-device-aaaa-bbbb',
    client_request_id: crypto.randomUUID(),
    ...overrides,
  }
}

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await resetDb()
})

afterEach(() => {
  setObjectStoreForTesting()
  setUpstreamFetchForTesting()
  setAsyncPollBackoffForTesting()
  _setChannelsForTesting([])
  mock.restore()
})

afterAll(async () => {
  await closeDb()
})

describe('operator recharge adjustments', () => {
  const headers = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }

  it('records signed adjustments and can empty recharge credits without spending subscription credits', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const expiresAt = Date.now() + 86_400_000
    await db
      .update(creditAccounts)
      .set({ subscription_balance: 5_000, subscription_expires_at: expiresAt })
      .where(eq(creditAccounts.user_id, userId))
    const path = `/internal/admin/private/billing/users/${userId}/recharge`
    const topup = await jsonReq(
      'POST',
      path,
      { amount: 4_000, reason: 'top up', payment: null },
      headers,
    )
    expect(topup.status).toBe(200)
    expect(topup.json.account?.recharge_balance).toBe(WELCOME + 4_000)
    const deducted = await jsonReq(
      'POST',
      path,
      { amount: -4_000, reason: '  correction  ', payment: null },
      headers,
    )
    expect(deducted.status).toBe(200)
    expect(deducted.json.account).toMatchObject({
      recharge_balance: WELCOME,
      subscription_balance: 5_000,
      subscription_expires_at: expiresAt,
    })
    const emptied = await jsonReq(
      'POST',
      path,
      { amount: -WELCOME, reason: 'empty recharge balance', payment: null },
      headers,
    )
    expect(emptied.status).toBe(200)
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account).toMatchObject({
      recharge_balance: 0,
      subscription_balance: 5_000,
      subscription_expires_at: expiresAt,
    })
    expect(state.ledger.filter((entry) => entry.entry_type === 'adjustment')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bucket: 'recharge', amount: 4_000, note: 'top up' }),
        expect.objectContaining({ bucket: 'recharge', amount: -4_000, note: 'correction' }),
        expect.objectContaining({ bucket: 'recharge', amount: -WELCOME }),
      ]),
    )
  })

  it('rejects overdrafts atomically even when subscription credits could cover them', async () => {
    await createAndLogin()
    const userId = await findUserId()
    await db
      .update(creditAccounts)
      .set({
        subscription_balance: 5_000,
        subscription_expires_at: Date.now() + 86_400_000,
      })
      .where(eq(creditAccounts.user_id, userId))
    const before = await Promise.all([
      db.select().from(creditAccounts),
      db.select().from(creditLedger),
      db.select().from(schema.operator_audits),
    ])
    const result = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/recharge`,
      { amount: -4_000, reason: 'overdraft', payment: null },
      headers,
    )
    expect(result.status).toBe(409)
    expect(result.json).toEqual({ error: 'insufficient_recharge_credits' })
    expect(
      await Promise.all([
        db.select().from(creditAccounts),
        db.select().from(creditLedger),
        db.select().from(schema.operator_audits),
      ]),
    ).toEqual(before)
  })

  it('serializes competing deductions so only the affordable adjustment commits', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const path = `/internal/admin/private/billing/users/${userId}/recharge`
    const results = await Promise.all([
      jsonReq('POST', path, { amount: -1_500, reason: 'first operator', payment: null }, headers),
      jsonReq('POST', path, { amount: -1_500, reason: 'second operator', payment: null }, headers),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(500)
    expect(state.ledger.filter((entry) => entry.entry_type === 'adjustment')).toMatchObject([
      { amount: -1_500, bucket: 'recharge' },
    ])
    const audits = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.action, 'billing.credits.adjust'))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.details).toMatchObject({ amount: -1_500 })
  })

  it('rejects invalid amounts, missing reasons, and unauthenticated deductions without posting entries', async () => {
    await createAndLogin()
    const userId = await findUserId()
    const path = `/internal/admin/private/billing/users/${userId}/recharge`
    const forbidden = await jsonReq('POST', path, {
      amount: -1,
      reason: 'no credentials',
      payment: null,
    })
    expect(forbidden.status).toBe(401)
    const zero = await jsonReq('POST', path, { amount: 0, reason: 'zero', payment: null }, headers)
    expect(zero.status).toBe(400)
    expect(zero.json.error).toBe('invalid_amount')
    const fraction = await jsonReq(
      'POST',
      path,
      { amount: -0.5, reason: 'fraction', payment: null },
      headers,
    )
    expect(fraction.status).toBe(400)
    const oversized = await jsonReq(
      'POST',
      path,
      { amount: -MAX_CREDIT_BALANCE - 1, reason: 'out of range', payment: null },
      headers,
    )
    expect(oversized.status).toBe(400)
    const blank = await jsonReq('POST', path, { amount: -1, reason: '   ', payment: null }, headers)
    expect(blank.status).toBe(400)
    expect(blank.json.error).toBe('reason_required')
    const [account] = await db.select().from(creditAccounts)
    expect(account?.recharge_balance).toBe(WELCOME)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.entry_type, 'adjustment')),
    ).toEqual([])
    expect(
      await db
        .select()
        .from(schema.operator_audits)
        .where(eq(schema.operator_audits.action, 'billing.credits.adjust')),
    ).toEqual([])
  })

  it('accepts the maximum balance but rejects overflowing top-ups without changing the ledger', async () => {
    await createAndLogin()
    const userId = await findUserId()
    const path = `/internal/admin/private/billing/users/${userId}/recharge`
    const filled = await jsonReq(
      'POST',
      path,
      { amount: MAX_CREDIT_BALANCE - WELCOME, reason: 'maximum', payment: null },
      headers,
    )
    expect(filled.status).toBe(200)
    expect(filled.json.account?.recharge_balance).toBe(MAX_CREDIT_BALANCE)
    const before = await db.select().from(creditLedger)
    const overflow = await jsonReq(
      'POST',
      path,
      { amount: 1, reason: 'overflow', payment: null },
      headers,
    )
    expect(overflow.status).toBe(400)
    expect(overflow.json).toEqual({ error: 'credit_balance_overflow' })
    const [account] = await db.select().from(creditAccounts)
    expect(account?.recharge_balance).toBe(MAX_CREDIT_BALANCE)
    expect(await db.select().from(creditLedger)).toEqual(before)
  })
})

describe('billing task lifecycle', () => {
  it('grants increasing concurrent task slots by active membership plan', async () => {
    const now = Date.now()
    const userId = 'tier-slots-user'
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: 'fixture',
      created_at: now,
      updated_at: now,
    })
    const limit = () =>
      db.transaction((tx) => privateTaskHooks.accountConcurrencyLimit!({ tx, userId, now }))
    expect(await limit()).toBe(1)
    await db.insert(subscriptions).values({
      id: 'tier-slots-subscription',
      user_id: userId,
      plan_id: 'starter',
      period_months: 1,
      starts_at: now - 1_000,
      ends_at: now + 60_000,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    expect(await limit()).toBe(1)
    await db
      .update(subscriptions)
      .set({ plan_id: 'standard' })
      .where(eq(subscriptions.user_id, userId))
    expect(await limit()).toBe(2)
    await db
      .update(subscriptions)
      .set({ plan_id: 'professional' })
      .where(eq(subscriptions.user_id, userId))
    expect(await limit()).toBe(3)
    await db.update(subscriptions).set({ ends_at: now }).where(eq(subscriptions.user_id, userId))
    expect(await limit()).toBe(1)
  })

  it('reports membership only while a subscription is active and within its period', async () => {
    const now = Date.now()
    const userId = 'member-check-user'
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: 'fixture',
      created_at: now,
      updated_at: now,
    })
    const member = () => privateTaskHooks.isActiveMember!({ userId, now })
    expect(await member()).toBe(false)
    await db.insert(subscriptions).values({
      id: 'member-check-subscription',
      user_id: userId,
      plan_id: 'starter',
      period_months: 1,
      starts_at: now - 1_000,
      ends_at: now + 60_000,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    expect(await member()).toBe(true)
    await db.update(subscriptions).set({ ends_at: now }).where(eq(subscriptions.user_id, userId))
    expect(await member()).toBe(false)
  })

  it('只给有效订阅的入门版空闲时可用并发 2，标准版、专业版和无订阅不变', async () => {
    const now = Date.now()
    const userId = 'idle-slots-user'
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: 'fixture',
      created_at: now,
      updated_at: now,
    })
    const entitlement = () =>
      db.transaction((tx) => privateTaskHooks.accountConcurrencyEntitlement!({ tx, userId, now }))
    expect(await entitlement()).toEqual({ guaranteed: 1, idle: 1 })
    await db.insert(subscriptions).values({
      id: 'idle-slots-subscription',
      user_id: userId,
      plan_id: 'starter',
      period_months: 1,
      starts_at: now - 1_000,
      ends_at: now + 60_000,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    expect(await entitlement()).toEqual({ guaranteed: 1, idle: 2 })
    await db
      .update(subscriptions)
      .set({ plan_id: 'standard' })
      .where(eq(subscriptions.user_id, userId))
    expect(await entitlement()).toEqual({ guaranteed: 2, idle: 2 })
    await db
      .update(subscriptions)
      .set({ plan_id: 'professional' })
      .where(eq(subscriptions.user_id, userId))
    expect(await entitlement()).toEqual({ guaranteed: 3, idle: 3 })
    await db.update(subscriptions).set({ ends_at: now }).where(eq(subscriptions.user_id, userId))
    expect(await entitlement()).toEqual({ guaranteed: 1, idle: 1 })
  })

  it('改价生成套餐新版本时沿用空闲并发，空闲并发不能小于保证并发', async () => {
    const auth = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
    const plan = (monthlyCredits: number) =>
      jsonReq(
        'PUT',
        '/internal/admin/private/billing/plans/idle-plan',
        {
          name: '弹性套餐',
          monthly_credits: monthlyCredits,
          active: false,
          sort_order: 98,
          prices: [{ period_months: 1, original_price_cents: 4_900 }],
        },
        auth,
      )
    expect((await plan(1_000)).status).toBe(200)
    const [created] = await db.select().from(plans).where(eq(plans.id, 'idle-plan'))
    expect(created?.idle_concurrent_tasks).toBeNull()
    await db.update(plans).set({ idle_concurrent_tasks: 2 }).where(eq(plans.id, 'idle-plan'))

    expect((await plan(2_000)).status).toBe(200)
    const versions = await db
      .select({ idle: plans.idle_concurrent_tasks, credits: plans.monthly_credits })
      .from(plans)
      .where(sql`${plans.id} like 'idle-plan-%'`)
    expect(versions).toEqual([{ idle: 2, credits: 2_000 }])

    const shrink = async () => {
      await db.update(plans).set({ idle_concurrent_tasks: 1 }).where(eq(plans.id, 'standard'))
    }
    await expect(shrink()).rejects.toThrow()
  })

  it('provisions welcome credits once when duplicate registrations race', async () => {
    const blocker = new SQL(TEST_DB, { max: 1 })
    const observer = new SQL(TEST_DB, { max: 1 })
    let registrations: Array<ReturnType<typeof jsonReq>> = []

    try {
      await blocker.begin(async (tx) => {
        await tx`LOCK TABLE users IN SHARE MODE`
        registrations = [
          jsonReq(
            'POST',
            '/api/auth/register',
            { username: 'new-user@example.com', password: LOGIN_PHRASE },
            { 'cf-connecting-ip': '10.30.0.1' },
          ),
          jsonReq(
            'POST',
            '/api/auth/register',
            { username: 'new-user@example.com', password: LOGIN_PHRASE },
            { 'cf-connecting-ip': '10.30.0.2' },
          ),
        ]
        await waitForBlockedUserInserts(observer, registrations.length)
      })

      const results = await Promise.all(registrations)
      expect(results.map(({ status }) => status).sort()).toEqual([201, 409])
      const registered = results.find(({ status }) => status === 201)
      const cookie = registered?.headers.get('set-cookie')?.split(';')[0]
      expect(cookie).toStartWith('image_playground_session=')

      const state = accountState(
        await jsonReq('GET', '/api/billing/account', undefined, { cookie: cookie! }),
      )
      expect(state.account.recharge_balance).toBe(WELCOME)
      expect(
        state.ledger.filter(
          (entry) => entry.entry_type === 'grant' && entry.reference_id === 'welcome-credit',
        ),
      ).toHaveLength(1)
    } finally {
      await Promise.all([blocker.close(), observer.close()])
    }
  })

  it('rejects an unaffordable submission before creating a task', async () => {
    const cookie = await createAndLogin()
    const priced = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/models/gpt-image-2',
      { credits_per_image: 6_000, active: true },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(priced.status).toBe(200)

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    expect(submitted.status).toBe(402)
    expect(submitted.json).toMatchObject({
      error: 'insufficient_credits',
      required: 6_000,
      available: WELCOME,
    })

    const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
    expect(tasks).toHaveLength(0)
    const account = await jsonReq('GET', '/api/billing/account', undefined, { cookie })
    expect(accountState(account).account.recharge_balance).toBe(WELCOME)
  })

  it('rejects a multi-image submission as one unaffordable order', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    await db
      .update(creditAccounts)
      .set({ recharge_balance: 200 })
      .where(eq(creditAccounts.user_id, userId))

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ n: 3 }),
      { cookie },
    )

    expect(submitted.status).toBe(402)
    expect(submitted.json).toMatchObject({
      error: 'insufficient_credits',
      required: 300,
      available: 200,
    })
    expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toHaveLength(0)
  })

  it('holds credits once when an idempotency key is submitted twice', async () => {
    const cookie = await createAndLogin()
    const body = submitBody({ n: 2 })

    const first = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', body, {
      cookie,
    })
    const second = await jsonReq('POST', '/v1/queue/openai-compat/gpt-image-2/submit', body, {
      cookie,
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(requestId(second)).toBe(requestId(first))

    const account = await jsonReq('GET', '/api/billing/account', undefined, { cookie })
    const state = accountState(account)
    expect(state.account.recharge_balance).toBe(WELCOME - 200)
    expect(
      state.ledger.filter(
        (entry) => entry.entry_type === 'hold' && entry.task_id === requestId(first),
      ),
    ).toHaveLength(1)
  })

  it('commits a hold after one upstream invocation', async () => {
    const cookie = await createAndLogin()
    setUpstreamFetchForTesting(
      mock(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: 'SU1BR0U=' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )

    const taskId = requestId(submitted)
    await runTask(taskId)

    const account = await jsonReq('GET', '/api/billing/account', undefined, { cookie })
    const state = accountState(account)
    expect(state.account.recharge_balance).toBe(WELCOME - 100)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'commit',
        task_id: taskId,
        metadata: { upstream_invocation_count: 1 },
      }),
    )
  })

  it('refunds the hold when the task fails after the upstream was invoked', async () => {
    const cookie = await createAndLogin()
    setUpstreamFetchForTesting(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: 'content policy violation' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    const taskId = requestId(submitted)

    await runTask(taskId)

    const [task] = await db
      .select({
        status: schema.tasks.status,
        invocationCount: schema.tasks.upstream_invocation_count,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
    expect(task?.status).toBe('failed')
    expect(task?.invocationCount).toBe(1)

    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
    expect(hold?.status).toBe('released')
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        bucket: 'recharge',
        entry_type: 'release',
        amount: 100,
        task_id: taskId,
        metadata: {
          upstream_invocation_count: 1,
          // 403 内容策略拒绝现在单独成一类；退款行为不变，分类更准。
          error_type: 'content_policy',
          upstream_status: 403,
        },
      }),
    )
    expect(state.ledger.filter((entry) => entry.entry_type === 'commit')).toHaveLength(0)
  })

  it('quotes a paid video stage by duration and resolution, matching the actual queue hold', async () => {
    const cookie = await usePerSecondVideoChannel()
    stubGrokVideo(() => new Response(MP4_BYTES, { status: 200 }))
    const userId = await findUserId()
    const video = videoSubmission().video
    const quote = await db.transaction((tx) =>
      privateTaskHooks.quoteTask!({
        tx,
        userId,
        model: 'grok-imagine-video',
        quantity: video.duration_seconds,
        unitMultiplier: videoRateMultiplier('grok-imagine-video', video.resolution),
      }),
    )
    expect(quote).toMatchObject({
      estimatedCredits: 1_024,
      pricing: { unit: 'second', quantity: 8, unitMultiplier: 1.6, baseUnitCredits: 80 },
    })
    const before = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(before.account.recharge_balance).toBe(WELCOME)
    expect(before.ledger.some((entry) => entry.entry_type === 'hold')).toBe(false)

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/grok-imagine-video/submit',
      submitBody(videoSubmission()),
      { cookie },
    )
    const taskId = requestId(submitted)

    const held = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(held.account.recharge_balance).toBe(WELCOME - 1_024)
    expect(held.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'hold',
        task_id: taskId,
        amount: -1_024,
        quantity: 8,
        metadata: { unit: 'second', unit_multiplier: 1.6 },
      }),
    )

    await runTask(taskId)

    const settled = accountState(
      await jsonReq('GET', '/api/billing/account', undefined, { cookie }),
    )
    expect(settled.account.recharge_balance).toBe(WELCOME - 1_024)
    expect(settled.ledger).toContainEqual(
      expect.objectContaining({ entry_type: 'commit', task_id: taskId, quantity: 8 }),
    )
  })

  it('returns the per-second hold when the video task fails', async () => {
    const cookie = await usePerSecondVideoChannel()
    setUpstreamFetchForTesting(
      mock(async () =>
        Response.json({ error: { message: 'content policy violation' } }, { status: 403 }),
      ) as unknown as TestFetch,
    )

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/grok-imagine-video/submit',
      submitBody(videoSubmission()),
      { cookie },
    )
    const taskId = requestId(submitted)

    await runTask(taskId)

    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
    expect(hold?.status).toBe('released')
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({ entry_type: 'release', task_id: taskId, amount: 1_024 }),
    )
  })

  it('keeps charging image models per image', async () => {
    const cookie = await createAndLogin()

    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ n: 2 }),
      { cookie },
    )

    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME - 200)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'hold',
        task_id: requestId(submitted),
        amount: -200,
        quantity: 2,
        metadata: { unit: 'image', unit_multiplier: 1 },
      }),
    )
  })

  it('records every upstream HTTP request in an internal Gemini fan-out', async () => {
    const cookie = await createAndLogin()
    setUpstreamFetchForTesting(
      mock(async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: 'SU1BR0U=' } }],
              },
            },
          ],
        }),
      ) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/gemini/gemini-3.1-flash-image/submit',
      submitBody({ n: 3 }),
      { cookie },
    )
    const taskId = requestId(submitted)

    await runTask(taskId)

    const [task] = await db
      .select({ invocationCount: schema.tasks.upstream_invocation_count })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
    expect(task?.invocationCount).toBe(3)
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'commit',
        task_id: taskId,
        quantity: 3,
        metadata: { upstream_invocation_count: 3 },
      }),
    )
  })

  it('returns held credits to their original bucket when failure happens before upstream', async () => {
    const cookie = await createAndLogin()
    const input = `data:image/png;base64,${Buffer.from('INPUT').toString('base64')}`
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody({ input_images: [input] }),
      { cookie },
    )
    storage.readFailuresRemaining = 1

    const taskId = requestId(submitted)
    await runTask(taskId)

    const account = await jsonReq('GET', '/api/billing/account', undefined, { cookie })
    const state = accountState(account)
    expect(state.account.recharge_balance).toBe(WELCOME)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        bucket: 'recharge',
        entry_type: 'release',
        amount: 100,
        task_id: taskId,
        metadata: { upstream_invocation_count: 0, error_type: 'object_storage_error' },
      }),
    )
  })
  it('settles an existing hold after billing is disabled', async () => {
    const cookie = await createAndLogin()
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    const taskId = requestId(submitted)
    const { config } = await import('../../../config')
    const capabilities = config.operator.capabilities as Record<string, boolean>
    capabilities['billing:credits'] = false
    try {
      const cancelled = await jsonReq('PUT', `/v1/queue/requests/${taskId}/cancel`, undefined, {
        cookie,
      })
      expect(cancelled.status).toBe(200)
    } finally {
      capabilities['billing:credits'] = true
    }

    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'release',
        task_id: taskId,
      }),
    )
  })
  it('skips billing maintenance when the capability is disabled', async () => {
    const { config } = await import('../../../config')
    const capabilities = config.operator.capabilities as Record<string, boolean>
    capabilities['billing:credits'] = false
    await db.execute(
      sql`ALTER TABLE billing_subscriptions RENAME TO billing_subscriptions_disabled`,
    )
    try {
      await expect(privateTaskHooks.runMaintenance(Date.now())).resolves.toBeUndefined()
    } finally {
      await db.execute(
        sql`ALTER TABLE billing_subscriptions_disabled RENAME TO billing_subscriptions`,
      )
      capabilities['billing:credits'] = true
    }
  })

  // 这类请求此前走到 worker 才在派发前失败，那时要把预扣退回来。如今提交时就按模型挡掉
  // （非 GPT Image 模型做不了原尺寸局部编辑），钉住的就是门口那一步：不建任务、一分不扣。
  // 「派发前失败要退预扣」本身由 `returns held credits … before upstream` 那条守着。
  it('rejects a masked edit the model cannot do at submission, before any credits are held', async () => {
    const cookie = await createAndLogin()
    await db
      .insert(modelPrices)
      .values({
        model: 'agnes-image-2.1-flash',
        credits_per_image: 100,
        active: true,
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: modelPrices.model,
        set: { credits_per_image: 100, active: true, updated_at: Date.now() },
      })
    _setChannelsForTesting([
      {
        id: 'agnes-images',
        kind: 'openai-queue',
        label: 'Agnes AI',
        baseUrl: 'https://fixture.example/v1',
        auth: { type: 'bearer', secretRef: 'AGNES_API_KEY', secret: 'fixture-key' },
        allowedPaths: ['images/generations'],
        models: [
          {
            id: 'agnes-image-2.1-flash',
            label: 'Agnes Image 2.1 Flash',
            capabilities: ['generate', 'edit'],
          },
        ],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    let upstreamCalls = 0
    setUpstreamFetchForTesting(
      mock(async () => {
        upstreamCalls += 1
        return Response.json({ data: [{ b64_json: 'SU1BR0U=' }] })
      }) as unknown as TestFetch,
    )
    // 一张真能解码的 PNG：拒绝发生在读完元数据之后、按模型名判，尺寸无关。
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/agnes-image-2.1-flash/submit',
      submitBody({ input_images: [image], mask: image }),
      { cookie },
    )

    expect(submitted.status).toBe(400)
    expect(submitted.json.error).toBe('invalid_input_image')
    expect(upstreamCalls).toBe(0)
    expect(await db.select().from(taskHolds)).toEqual([])
    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME)
  })
  it('releases a cross-bucket hold back to both original buckets on cancellation', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: Date.now(),
        reason: 'fixture subscription',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(subscribed.status).toBe(200)
    const priced = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/models/gpt-image-2',
      { credits_per_image: 66_050, active: true },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(priced.status).toBe(200)
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    const taskId = requestId(submitted)
    const held = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(held.account).toMatchObject({ subscription_balance: 0, recharge_balance: WELCOME - 50 })

    const cancelled = await jsonReq('PUT', `/v1/queue/requests/${taskId}/cancel`, undefined, {
      cookie,
    })
    expect(cancelled.status).toBe(200)
    const released = accountState(
      await jsonReq('GET', '/api/billing/account', undefined, { cookie }),
    )
    expect(released.account).toMatchObject({
      subscription_balance: 66_000,
      recharge_balance: WELCOME,
    })
    expect(
      released.ledger
        .filter((entry) => entry.entry_type === 'release' && entry.task_id === taskId)
        .map((entry) => [entry.bucket, entry.amount])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ['recharge', 50],
      ['subscription', 66_000],
    ])
  })
  it('does not release an expired subscription hold into the next monthly bucket', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 12,
        starts_at: Date.now(),
        reason: 'annual rollover fixture',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const id = subscriptionId(subscribed)
    await jsonReq(
      'PUT',
      '/internal/admin/private/billing/models/gpt-image-2',
      { credits_per_image: 66_050, active: true },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    const taskId = requestId(submitted)
    const dueAt = Date.now() - 1
    await db
      .update(creditAccounts)
      .set({ subscription_expires_at: dueAt })
      .where(eq(creditAccounts.user_id, userId))
    await db.update(subscriptions).set({ next_grant_at: dueAt }).where(eq(subscriptions.id, id))

    const renewed = accountState(
      await jsonReq('GET', '/api/billing/account', undefined, { cookie }),
    )
    expect(renewed.account).toMatchObject({
      subscription_balance: 66_000,
      recharge_balance: WELCOME - 50,
    })
    const cancelled = await jsonReq('PUT', `/v1/queue/requests/${taskId}/cancel`, undefined, {
      cookie,
    })
    expect(cancelled.status).toBe(200)

    const released = accountState(
      await jsonReq('GET', '/api/billing/account', undefined, { cookie }),
    )
    expect(released.account).toMatchObject({
      subscription_balance: 66_000,
      recharge_balance: WELCOME,
    })
    expect(released.ledger).toContainEqual(
      expect.objectContaining({
        task_id: taskId,
        bucket: 'subscription',
        entry_type: 'release',
        amount: 0,
        note: '66000 套餐积分已过期，未退回',
        metadata: {
          upstream_invocation_count: 0,
          expired_amount: 66_000,
        },
      }),
    )
  })

  it('charges one hold across retries and records the real invocation count', async () => {
    const cookie = await createAndLogin()
    let attempts = 0
    setUpstreamFetchForTesting(
      mock(async () => {
        attempts += 1
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'temporary' } }), {
            status: 503,
          })
        }
        return new Response(JSON.stringify({ data: [{ b64_json: 'SU1BR0U=' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as TestFetch,
    )
    const submitted = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-2/submit',
      submitBody(),
      { cookie },
    )
    const taskId = requestId(submitted)

    await runTask(taskId)
    await db
      .update(schema.tasks)
      .set({ next_retry_at: Date.now() - 1 })
      .where(eq(schema.tasks.id, taskId))
    await runTask(taskId)

    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(state.account.recharge_balance).toBe(WELCOME - 100)
    expect(
      state.ledger.filter((entry) => entry.entry_type === 'hold' && entry.task_id === taskId),
    ).toHaveLength(1)
    expect(state.ledger).toContainEqual(
      expect.objectContaining({
        entry_type: 'commit',
        task_id: taskId,
        metadata: { upstream_invocation_count: 2 },
      }),
    )
  })

  it('lazily expires and grants the next monthly subscription allocation once', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 12,
        starts_at: Date.now(),
        reason: 'annual fixture subscription',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const id = subscriptionId(subscribed)
    const dueAt = Date.now() - 1
    await db
      .update(creditAccounts)
      .set({ subscription_expires_at: dueAt })
      .where(eq(creditAccounts.user_id, userId))
    await db.update(subscriptions).set({ next_grant_at: dueAt }).where(eq(subscriptions.id, id))

    const first = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    const second = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))

    expect(first.account.subscription_balance).toBe(66_000)
    expect(
      first.ledger.filter(
        (entry) => entry.entry_type === 'grant' && entry.bucket === 'subscription',
      ),
    ).toHaveLength(2)
    expect(
      second.ledger.filter(
        (entry) => entry.entry_type === 'grant' && entry.bucket === 'subscription',
      ),
    ).toHaveLength(2)
  })
  it('clears an expired empty bucket and scans subscriptions with no next grant', async () => {
    await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: Date.now(),
        reason: 'expiry scan fixture',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const id = subscriptionId(subscribed)
    const dueAt = Date.now() - 1
    await db
      .update(creditAccounts)
      .set({ subscription_balance: 0, subscription_expires_at: dueAt })
      .where(eq(creditAccounts.user_id, userId))
    await db
      .update(subscriptions)
      .set({ next_grant_at: null, ends_at: dueAt })
      .where(eq(subscriptions.id, id))

    expect(await scanDueAccounts()).toBe(1)
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, userId))
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.id, id))
    expect(account?.subscription_expires_at).toBeNull()
    expect(subscription?.status).toBe('expired')
  })

  it('seeds every discovered operator model at the default price without overwriting edits', async () => {
    _setChannelsForTesting([
      {
        id: 'fixture-channel',
        kind: 'openai-queue',
        label: 'Fixture',
        baseUrl: 'https://fixture.example/v1',
        auth: { type: 'bearer', secretRef: 'FIXTURE_KEY', secret: 'fixture-key' },
        allowedPaths: ['images/generations'],
        models: [
          { id: 'fixture-new-model', label: 'Fixture New', capabilities: ['generate'] },
          { id: 'gpt-image-2', label: 'Existing', capabilities: ['generate'] },
          {
            id: 'fixture-video-model',
            label: 'Fixture Video',
            media: 'video',
            capabilities: ['generate', 'duration'],
          },
        ],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    await db
      .update(modelPrices)
      .set({ credits_per_image: 321 })
      .where(eq(modelPrices.model, 'gpt-image-2'))

    await syncModelPricesFromChannels()

    const rows = await db
      .select({
        model: modelPrices.model,
        price: modelPrices.credits_per_image,
        unit: modelPrices.unit,
      })
      .from(modelPrices)
    expect(rows).toContainEqual({ model: 'fixture-new-model', price: 100, unit: 'image' })
    expect(rows).toContainEqual({ model: 'gpt-image-2', price: 321, unit: 'image' })
    expect(rows).toContainEqual({ model: 'fixture-video-model', price: 100, unit: 'second' })
  })
  it('rolls back a model price when its audit insert fails', async () => {
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION reject_fixture_model_price_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'billing.model_price.update' THEN
            RAISE EXCEPTION 'fixture audit failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER reject_fixture_model_price_audit
        BEFORE INSERT ON operator_audits
        FOR EACH ROW EXECUTE FUNCTION reject_fixture_model_price_audit();
      `),
    )
    try {
      const updated = await jsonReq(
        'PUT',
        '/internal/admin/private/billing/models/gpt-image-2',
        { credits_per_image: 321, active: true },
        { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
      )
      expect(updated.status).toBe(400)
    } finally {
      await db.execute(
        sql.raw(`
          DROP TRIGGER IF EXISTS reject_fixture_model_price_audit ON operator_audits;
          DROP FUNCTION IF EXISTS reject_fixture_model_price_audit();
        `),
      )
    }

    const [price] = await db
      .select({ creditsPerImage: modelPrices.credits_per_image })
      .from(modelPrices)
      .where(eq(modelPrices.model, 'gpt-image-2'))
    expect(price?.creditsPerImage).toBe(100)
  })

  it('adjusts subscription expiry only through an audited operator route', async () => {
    await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: Date.now(),
        reason: 'fixture subscription',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const id = subscriptionId(subscribed)
    const endsAt = Date.now() + 45 * 24 * 60 * 60 * 1_000

    const adjusted = await jsonReq(
      'POST',
      `/internal/admin/private/billing/subscriptions/${id}/expiry`,
      { ends_at: endsAt, reason: 'manual extension' },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )

    expect(adjusted.status).toBe(200)
    expect(adjusted.json).toMatchObject({ subscription_id: id, ends_at: endsAt })
    const [stored] = await db
      .select({ endsAt: subscriptions.ends_at })
      .from(subscriptions)
      .where(eq(subscriptions.id, id))
    expect(stored?.endsAt).toBe(endsAt)

    const shortened = Date.now() + 20 * 24 * 60 * 60 * 1_000
    const aligned = await jsonReq(
      'POST',
      `/internal/admin/private/billing/subscriptions/${id}/expiry`,
      { ends_at: shortened, reason: 'align to payment day' },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(aligned.status).toBe(200)
    const [after] = await db
      .select({ nextGrantAt: subscriptions.next_grant_at })
      .from(subscriptions)
      .where(eq(subscriptions.id, id))
    const [account] = await db
      .select({ expiresAt: creditAccounts.subscription_expires_at })
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, userId))
    // 20 天后截止：这一周期内不再有第二次月度发放，积分跟着截止日到期。
    expect(after?.nextGrantAt).toBeNull()
    expect(account?.expiresAt).toBe(shortened)
  })
  it('issues exactly one monthly grant per purchased month from a month-end anchor', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const subscribed = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 3,
        starts_at: Date.UTC(2020, 0, 31),
        reason: 'month-end anchor fixture',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    const id = subscriptionId(subscribed)

    const state = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
    expect(
      state.ledger.filter((entry) => entry.entry_type === 'grant' && entry.reference_id === id),
    ).toHaveLength(3)
  })

  it('extends only the current plan when renewing an active subscription', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const auth = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
    const first = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: Date.now(),
        reason: 'initial subscription',
        payment: null,
      },
      auth,
    )
    expect(first.status).toBe(200)
    const [before] = await db
      .select({
        planId: subscriptions.plan_id,
        periodMonths: subscriptions.period_months,
        endsAt: subscriptions.ends_at,
      })
      .from(subscriptions)
      .where(eq(subscriptions.user_id, userId))

    const gapRenewal = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: (before?.endsAt ?? 0) + 24 * 60 * 60 * 1_000,
        reason: 'invalid delayed renewal',
        payment: null,
      },
      auth,
    )
    expect(gapRenewal).toMatchObject({
      status: 400,
      json: { error: 'renewal_start_after_current_end' },
    })

    const wrongPlan = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'standard',
        period_months: 3,
        starts_at: Date.now(),
        reason: 'cross-tier renewal',
        payment: null,
      },
      auth,
    )
    expect(wrongPlan).toMatchObject({
      status: 400,
      json: { error: 'active_subscription_plan_mismatch' },
    })

    const renewal = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 12,
        starts_at: Date.now(),
        reason: 'annual renewal',
        payment: null,
      },
      auth,
    )
    expect(renewal.status).toBe(200)
    const [after] = await db
      .select({
        planId: subscriptions.plan_id,
        periodMonths: subscriptions.period_months,
        endsAt: subscriptions.ends_at,
      })
      .from(subscriptions)
      .where(eq(subscriptions.user_id, userId))
    expect(after).toMatchObject({ planId: 'starter', periodMonths: 1 })
    expect(after?.endsAt).toBeGreaterThan(before?.endsAt ?? Number.POSITIVE_INFINITY)
  })

  it('rejects plan discounts that do not have an expiry', async () => {
    const updated = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/plans/starter',
      {
        name: '入门',
        monthly_credits: 66_000,
        active: true,
        sort_order: 10,
        prices: [
          {
            period_months: 1,
            original_price_cents: 4_900,
            discount_price_cents: 3_900,
          },
        ],
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )

    expect(updated).toMatchObject({
      status: 400,
      json: { error: 'discount_deadline_required' },
    })
  })

  it('keeps inactive plans editable in the operator catalog but hides them from users', async () => {
    const cookie = await createAndLogin()
    const updated = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/plans/starter',
      {
        name: '入门',
        monthly_credits: 66_000,
        active: false,
        sort_order: 10,
        prices: [
          { period_months: 1, original_price_cents: 4_900 },
          { period_months: 3, original_price_cents: 14_700 },
          { period_months: 12, original_price_cents: 58_800 },
        ],
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(updated.status).toBe(200)

    const operatorCatalog = await jsonReq(
      'GET',
      '/internal/admin/private/billing/catalog',
      undefined,
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(operatorCatalog.json.plans).toContainEqual(
      expect.objectContaining({ id: 'starter', active: false }),
    )

    const userCatalog = await jsonReq('GET', '/api/billing/catalog', undefined, { cookie })
    expect(userCatalog.json.plans?.some((plan) => plan.id === 'starter')).toBe(false)
    const userId = await findUserId()
    const grant = await jsonReq(
      'POST',
      `/internal/admin/private/billing/users/${userId}/subscriptions`,
      {
        plan_id: 'starter',
        period_months: 1,
        starts_at: Date.now(),
        reason: 'inactive plan must not sell',
        payment: null,
      },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(grant).toMatchObject({ status: 400, json: { error: 'plan_inactive' } })
  })
  it('removes stale plan periods when the operator replaces a plan', async () => {
    const auth = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
    const basePlan = {
      name: '可变套餐',
      monthly_credits: 1_000,
      active: true,
      sort_order: 99,
    }
    const first = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/plans/mutable',
      {
        ...basePlan,
        prices: [
          { period_months: 1, original_price_cents: 1_000 },
          { period_months: 3, original_price_cents: 2_700 },
        ],
      },
      auth,
    )
    expect(first.status).toBe(200)
    const second = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/plans/mutable',
      {
        ...basePlan,
        prices: [{ period_months: 1, original_price_cents: 900 }],
      },
      auth,
    )
    expect(second.status).toBe(200)

    const catalog = await jsonReq('GET', '/internal/admin/private/billing/catalog', undefined, auth)
    expect(catalog.json.plans?.find((plan) => plan.id === 'mutable')?.prices).toEqual([
      expect.objectContaining({ period_months: 1 }),
    ])
  })

  it('paginates the complete user ledger in stable reverse chronological order', async () => {
    const cookie = await createAndLogin()
    const userId = await findUserId()
    const now = Date.now()
    await db.insert(creditLedger).values(
      [1, 2, 3].map((sequence) => ({
        id: `paging-entry-${sequence}`,
        user_id: userId,
        bucket: 'recharge',
        entry_type: 'adjustment',
        amount: sequence,
        metadata: {},
        created_at: now + sequence,
      })),
    )

    const first = ledgerPage(
      await jsonReq('GET', '/api/billing/ledger?offset=0&limit=2', undefined, { cookie }),
    )
    const second = ledgerPage(
      await jsonReq('GET', '/api/billing/ledger?offset=2&limit=2', undefined, { cookie }),
    )

    expect(first.ledger.map((entry) => entry.amount)).toEqual([3, 2])
    expect(first.next_offset).toBe(2)
    expect(second.ledger[0]?.amount).toBe(1)
  })

  it('round-trips the contact QR through the settings endpoint into both catalogs', async () => {
    const auth = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
    const saved = await jsonReq(
      'PUT',
      '/internal/admin/private/billing/settings',
      {
        contact_wechat: 'operator-wechat',
        payment_qr_url: '/op/payment-qr.png',
        contact_qr_url: '/op/contact-qr.png',
        guidance: '付款后请发送用户名与付款截图。',
      },
      auth,
    )
    expect(saved.status).toBe(200)

    const operatorCatalog = await jsonReq(
      'GET',
      '/internal/admin/private/billing/catalog',
      undefined,
      auth,
    )
    expect(operatorCatalog.json.settings).toMatchObject({
      payment_qr_url: '/op/payment-qr.png',
      contact_qr_url: '/op/contact-qr.png',
    })

    const cookie = await createAndLogin()
    const userCatalog = await jsonReq('GET', '/api/billing/catalog', undefined, { cookie })
    expect(userCatalog.json.settings).toMatchObject({
      contact_wechat: 'operator-wechat',
      contact_qr_url: '/op/contact-qr.png',
    })
  })
})

it('retains a real credit hold for an unknown result and releases it exactly once after reconciliation', async () => {
  const cookie = await createAndLogin()
  let dispatches = 0
  setUpstreamFetchForTesting(async () => {
    dispatches++
    throw new Error('connection lost after upstream accepted generation')
  })
  const submitted = await jsonReq(
    'POST',
    '/v1/queue/openai-compat/gpt-image-2/submit',
    submitBody(),
    { cookie },
  )
  expect(submitted.status).toBe(200)
  const taskId = requestId(submitted)
  // Fixture for the future server-only producer. Public submit never accepts this flag.
  await db
    .update(schema.tasks)
    .set({ reconciliation_required: true })
    .where(eq(schema.tasks.id, taskId))
  await runTask(taskId)

  const status = await jsonReq('GET', `/v1/queue/requests/${taskId}/status`, undefined, { cookie })
  expect(status.json).toMatchObject({ status: 'reconciling' })
  const cancelled = await jsonReq('PUT', `/v1/queue/requests/${taskId}/cancel`, undefined, {
    cookie,
  })
  expect(cancelled.json).toMatchObject({ status: 'reconciling' })
  await recoverTasksByIds([taskId])
  await purgeOldTasks(0)
  await scanDueAccounts()
  await runTask(taskId)

  const [held] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
  expect(held).toMatchObject({
    status: 'held',
    total_amount: 100,
    settled_at: null,
    net_spend: null,
  })
  const before = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
  expect(before.account.recharge_balance).toBe(WELCOME - 100)
  expect(before.ledger.filter((entry) => entry.task_id === taskId)).toEqual([
    expect.objectContaining({ entry_type: 'hold', bucket: 'recharge', amount: -100 }),
  ])

  const path = `/internal/admin/tasks/${taskId}/reconciliation`
  const headers = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
  const command = {
    commandId: 'billing-confirm-absence',
    operatorId: 'billing-test-operator',
    action: 'confirm_no_result',
    evidence: 'Provider support case confirms that the original request produced no result.',
  }
  const resolved = await jsonReq('POST', path, command, headers)
  expect(resolved.status).toBe(200)
  expect(resolved.json).toMatchObject({ status: 'failed' })
  const replay = await jsonReq('POST', path, command, headers)
  expect(replay.status).toBe(200)
  expect(replay.json).toMatchObject({ status: 'failed' })
  expect(
    (await jsonReq('POST', path, { ...command, commandId: 'second-absence-command' }, headers))
      .status,
  ).toBe(409)

  const [released] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
  expect(released).toMatchObject({
    status: 'released',
    net_spend: 0,
    settled_at: expect.any(Number),
  })
  const after = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
  expect(after.account.recharge_balance).toBe(WELCOME)
  const ledger = after.ledger.filter((entry) => entry.task_id === taskId)
  expect(ledger.filter((entry) => entry.entry_type === 'hold')).toHaveLength(1)
  expect(ledger.filter((entry) => entry.entry_type === 'commit')).toHaveLength(0)
  expect(ledger.filter((entry) => entry.entry_type === 'release')).toEqual([
    expect.objectContaining({
      amount: 100,
      bucket: 'recharge',
      metadata: {
        upstream_invocation_count: 1,
        error_type: 'upstream_no_image',
      },
    }),
  ])
  expect(dispatches).toBe(1)
})

it('retains a real credit hold until a reconciled result is archived and commits it exactly once', async () => {
  const cookie = await createAndLogin()
  let dispatches = 0
  setUpstreamFetchForTesting(async () => {
    dispatches++
    throw new Error('connection lost after upstream accepted generation')
  })
  const submitted = await jsonReq(
    'POST',
    '/v1/queue/openai-compat/gpt-image-2/submit',
    submitBody(),
    { cookie },
  )
  expect(submitted.status).toBe(200)
  const taskId = requestId(submitted)
  await db
    .update(schema.tasks)
    .set({ reconciliation_required: true })
    .where(eq(schema.tasks.id, taskId))
  await runTask(taskId)

  const status = await jsonReq('GET', `/v1/queue/requests/${taskId}/status`, undefined, { cookie })
  expect(status.json).toMatchObject({ status: 'reconciling' })
  const [held] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
  expect(held).toMatchObject({
    status: 'held',
    total_amount: 100,
    settled_at: null,
    net_spend: null,
  })
  const before = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
  expect(before.account.recharge_balance).toBe(WELCOME - 100)
  expect(before.ledger.filter((entry) => entry.task_id === taskId)).toEqual([
    expect.objectContaining({ entry_type: 'hold', bucket: 'recharge', amount: -100 }),
  ])

  // A real 1x1 PNG; fixture accounts:sync is off, so the normal object-store archive runs.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYffY9AASOAmjVJJtvAAAAAElFTkSuQmCC'
  const path = `/internal/admin/tasks/${taskId}/reconciliation`
  const headers = { authorization: `Bearer ${SERVICE_CREDENTIAL}` }
  const command = {
    commandId: 'billing-confirm-result',
    operatorId: 'billing-test-operator',
    action: 'confirm_success',
    evidence: 'Provider support exported the completed image from the original request.',
    result: { data: [{ b64_json: png }] },
  }
  const resolved = await jsonReq('POST', path, command, headers)
  expect(resolved.status).toBe(200)
  expect(resolved.json).toMatchObject({ status: 'completed' })
  const replay = await jsonReq('POST', path, command, headers)
  expect(replay.status).toBe(200)
  expect(replay.json).toMatchObject({ status: 'completed' })
  expect(
    (await jsonReq('POST', path, { ...command, commandId: 'second-success-command' }, headers))
      .status,
  ).toBe(409)
  const image = await app.handle(
    new Request(`http://localhost/v1/queue/requests/${taskId}/image/0`, {
      headers: { cookie },
    }),
  )
  expect(image.status).toBe(200)
  expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(png, 'base64'))

  const [committed] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId))
  expect(committed).toMatchObject({
    status: 'committed',
    net_spend: 100,
    settled_at: expect.any(Number),
  })
  const after = accountState(await jsonReq('GET', '/api/billing/account', undefined, { cookie }))
  expect(after.account.recharge_balance).toBe(WELCOME - 100)
  const ledger = after.ledger.filter((entry) => entry.task_id === taskId)
  expect(ledger.filter((entry) => entry.entry_type === 'hold')).toHaveLength(1)
  expect(ledger.filter((entry) => entry.entry_type === 'release')).toHaveLength(0)
  expect(ledger.filter((entry) => entry.entry_type === 'commit')).toEqual([
    expect.objectContaining({
      amount: 0,
      bucket: 'recharge',
      metadata: { upstream_invocation_count: 1 },
    }),
  ])
  expect(dispatches).toBe(1)
})
