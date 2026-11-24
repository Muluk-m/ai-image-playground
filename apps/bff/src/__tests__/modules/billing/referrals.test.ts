import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  accountFacts,
  creditAccounts,
  referralProfiles,
  referralRelationships,
  referralRewards,
  subscriptions,
  unmeteredEntitlements,
} from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import type {
  OperatorAccountSnapshot,
  ReferralPolicy,
  ReferralRewardPage,
  ReferralSummary,
  ReferralTransferResult,
  UserSummaryResponse,
} from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'

const databaseUrl = await resetTestDatabase('billing_referrals')
const serviceCredential = 'referral-fixture-service-credential'
const password = 'referral-fixture-password'
const operatorHeaders = { authorization: `Bearer ${serviceCredential}` }

process.env.PORT = '0'
process.env.DATABASE_URL = databaseUrl
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.INTERNAL_API_TOKEN = serviceCredential
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
process.env.WELCOME_CREDITS = '2000'
process.env.CLIENT_IP_SOURCE = 'cf-connecting-ip'
process.env.OAUTH_GOOGLE_CLIENT_ID = 'referral-google-fixture'
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'referral-google-secret-fixture'

// These module singletons must load after the isolated database and operator environment are set.
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(databaseUrl)
const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close, db, schema } = await import('../../../db/client')
const { config } = await import('../../../config')
const { setOAuthFetchForTesting } = await import('../../../lib/oauth')

type ResponseBody = Partial<
  OperatorAccountSnapshot &
    ReferralSummary &
    ReferralRewardPage &
    ReferralTransferResult &
    ReferralPolicy &
    UserSummaryResponse
> & {
  error?: string
  user?: { id: string; username: string }
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json: ResponseBody = response.headers.get('content-type')?.includes('json')
    ? await response.json()
    : { error: await response.text() }
  return { status: response.status, headers: response.headers, json }
}

async function createOperatorUser() {
  const username = `ref-${randomUUID().slice(0, 12)}`
  const created = await request(
    'POST',
    '/internal/admin/users',
    { username, password },
    operatorHeaders,
  )
  expect(created.status).toBe(201)
  if (!created.json.user) throw new Error('User creation did not return the created user')
  const login = await request('POST', '/api/auth/login', { username, password })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Login did not establish a session')
  return { id: created.json.user.id, cookie, username }
}

afterAll(close)
afterEach(() => setOAuthFetchForTesting())

const defaultPolicy: ReferralPolicy = {
  inviter_registration_credits: 200,
  invitee_registration_credits: 200,
  paid_reward_basis_points: 500,
  credits_per_yuan: 100,
}
const policyPath = '/internal/admin/private/billing/referrals/policy'
beforeEach(async () => {
  expect((await request('PUT', policyPath, defaultPolicy, operatorHeaders)).status).toBe(200)
})

let signupSequence = 1
function signup(body: unknown, headers: Record<string, string> = {}) {
  return request('POST', '/api/auth/register', body, {
    'cf-connecting-ip': `10.81.0.${signupSequence++}`,
    ...headers,
  })
}

async function summary(user: { cookie: string }): Promise<ReferralSummary> {
  const result = await request('GET', '/api/billing/referrals', undefined, { cookie: user.cookie })
  expect(result.status).toBe(200)
  if (!result.json.code) throw new Error('Missing invitation code')
  return result.json as ReferralSummary
}

async function account(user: { cookie: string }) {
  const result = await request('GET', '/api/billing/account', undefined, { cookie: user.cookie })
  expect(result.status).toBe(200)
  if (!result.json.account) throw new Error('Missing credit account')
  return result.json.account
}

async function invitedUser(code: string) {
  const username = `inv-${randomUUID().slice(0, 12)}@example.com`
  const result = await signup({ username, password, referral_code: code })
  expect(result.status).toBe(201)
  const cookie = result.headers
    .getSetCookie()
    .find((value) => value.startsWith('image_playground_session='))
    ?.split(';')[0]
  if (!result.json.user || !cookie) throw new Error('Missing registered user/session')
  return { id: result.json.user.id, cookie, username }
}

async function pair() {
  const inviter = await createOperatorUser()
  const { code } = await summary(inviter)
  return { inviter, invitee: await invitedUser(code), code }
}

// Historical payments remain valid fixtures; new paid writes use the order API.
async function pay(
  user: { id: string },
  cents: number,
  operationId = randomUUID(),
  credits = 4_000,
) {
  const { adjustRechargeCredits } = await import('../../../modules/billing/ledger')
  const body = {
    amount: credits,
    reason: 'confirmed fixture payment',
    payment: { operation_id: operationId, amount_cents: cents },
  }
  try {
    await adjustRechargeCredits({
      userId: user.id,
      amount: credits,
      reason: body.reason,
      payment: body.payment,
    })
    return request(
      'POST',
      `/internal/admin/private/billing/users/${user.id}/recharge`,
      body,
      operatorHeaders,
    )
  } catch (error) {
    const code = error instanceof Error ? error.message : 'billing_operation_failed'
    return {
      status: code === 'payment_conflict' ? 409 : code === 'credit_balance_overflow' ? 400 : 500,
      json: { error: code } as ResponseBody,
    }
  }
}

function transfer(user: { cookie: string }, operationId: string) {
  return request(
    'POST',
    '/api/billing/referrals/transfer',
    { operation_id: operationId },
    { cookie: user.cookie },
  )
}

async function payments(user: { id: string }) {
  const result = await request(
    'GET',
    `/internal/admin/private/billing/users/${user.id}`,
    undefined,
    operatorHeaders,
  )
  expect(result.status).toBe(200)
  if (!result.json.payments) throw new Error('Missing confirmed payments')
  return result.json.payments
}

describe('confirmed referral payments', () => {
  it('credits a confirmed recharge once when its payment confirmation is retried', async () => {
    const user = await createOperatorUser()
    const payment = { operation_id: randomUUID(), amount_cents: 10_000 }
    const body = { amount: 4_000, reason: '实际收款 100 元', payment }
    const path = `/internal/admin/private/billing/users/${user.id}/recharge`

    const { adjustRechargeCredits } = await import('../../../modules/billing/ledger')
    await adjustRechargeCredits({
      userId: user.id,
      amount: body.amount,
      reason: body.reason,
      payment: body.payment,
    })
    expect((await request('POST', path, body, operatorHeaders)).status).toBe(200)
    expect((await request('POST', path, body, operatorHeaders)).status).toBe(200)

    const account = await request('GET', '/api/billing/account', undefined, { cookie: user.cookie })
    expect(account.status).toBe(200)
    expect(account.json.account?.recharge_balance).toBe(6_000)
    expect(account.json.ledger?.filter((entry) => entry.entry_type === 'recharge')).toHaveLength(1)
  })
})

describe('invitation registration', () => {
  it('denies no-wallet enterprise referral issuance without creating a profile or wallet', async () => {
    const inviter = await createOperatorUser()
    await db.delete(creditAccounts).where(eq(creditAccounts.user_id, inviter.id))
    await db.insert(accountFacts).values({
      user_id: inviter.id,
      category: 'feishu_unmetered',
      created_at: Date.now(),
    })
    const denied = await request('GET', '/api/billing/referrals', undefined, {
      cookie: inviter.cookie,
    })
    expect(denied.status).toBe(403)
    expect(denied.json.error).toBe('billing_account_unavailable')
    const deniedTransfer = await transfer(inviter, randomUUID())
    expect(deniedTransfer.status).toBe(403)
    expect(deniedTransfer.json.error).toBe('billing_account_unavailable')
    expect(
      await db.select().from(referralProfiles).where(eq(referralProfiles.user_id, inviter.id)),
    ).toEqual([])
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, inviter.id)),
    ).toEqual([])
  })

  it.each([
    200, 0,
  ])('rejects an existing no-wallet invitation before rewards with inviter grant %i', async (inviterCredits) => {
    const inviter = await createOperatorUser()
    const { code } = await summary(inviter)
    await db.delete(creditAccounts).where(eq(creditAccounts.user_id, inviter.id))
    await db.insert(accountFacts).values({
      user_id: inviter.id,
      category: 'feishu_unmetered',
      created_at: Date.now(),
    })
    const unavailable = await request('GET', '/api/billing/referrals', undefined, {
      cookie: inviter.cookie,
    })
    expect(unavailable.status).toBe(403)
    expect(unavailable.json.error).toBe('billing_account_unavailable')
    expect(
      (
        await request(
          'PUT',
          policyPath,
          {
            ...defaultPolicy,
            inviter_registration_credits: inviterCredits,
          },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    const username = `blocked-${randomUUID().slice(0, 12)}@example.com`
    const rejected = await signup({ username, password, referral_code: code })
    expect(rejected.status).toBe(400)
    expect(rejected.json.error).toBe('invalid_referral_code')
    expect(
      rejected.headers
        .getSetCookie()
        .some((value) => value.startsWith('image_playground_session=')),
    ).toBe(false)
    expect(await db.select().from(schema.users).where(eq(schema.users.username, username))).toEqual(
      [],
    )
    expect(
      await db
        .select()
        .from(referralRelationships)
        .where(eq(referralRelationships.inviter_user_id, inviter.id)),
    ).toEqual([])
    expect(
      await db.select().from(referralRewards).where(eq(referralRewards.user_id, inviter.id)),
    ).toEqual([])
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, inviter.id)),
    ).toEqual([])
    expect((await signup({ username, password })).status).toBe(201)
  })

  it('preserves referrals and reward transfers for an enterprise identity with an existing paid wallet', async () => {
    const inviter = await createOperatorUser()
    await db.insert(accountFacts).values({
      user_id: inviter.id,
      category: 'feishu_unmetered',
      created_at: Date.now(),
    })
    await db.insert(unmeteredEntitlements).values({ user_id: inviter.id, updated_at: Date.now() })
    const { code } = await summary(inviter)
    const invitee = await invitedUser(code)
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, inviter.id)),
    ).toEqual([expect.objectContaining({ recharge_balance: 2_200 })])
    expect(await account(invitee)).toMatchObject({ recharge_balance: 2_200 })
    expect((await pay(invitee, 10_000)).status).toBe(200)
    expect(await summary(inviter)).toMatchObject({
      invitation_count: 1,
      reward_balance: 500,
      total_rewards: 700,
    })
    const transferred = await transfer(inviter, randomUUID())
    expect(transferred.status).toBe(200)
    expect(transferred.json.transferred_credits).toBe(500)
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, inviter.id)),
    ).toEqual([expect.objectContaining({ recharge_balance: 2_700 })])
  })

  it('rejects an invalid invitation before creating the account and lets the user clear it', async () => {
    const username = `ref-${randomUUID().slice(0, 12)}@example.com`
    const headers = { 'cf-connecting-ip': '10.80.0.1' }
    const rejected = await request(
      'POST',
      '/api/auth/register',
      { username, password, referral_code: 'invalid-code' },
      headers,
    )
    expect(rejected.status).toBe(400)
    expect(rejected.json.error).toBe('invalid_referral_code')
    const ordinary = await request('POST', '/api/auth/register', { username, password }, headers)
    expect(ordinary.status).toBe(201)
  })
})

describe('Admin registration provenance', () => {
  it('distinguishes invited users and names their direct inviter', async () => {
    const { inviter, invitee } = await pair()
    const result = await request(
      'GET',
      `/internal/admin/private/billing/users?ids=${inviter.id},${invitee.id}`,
      undefined,
      operatorHeaders,
    )

    expect(result.status).toBe(200)
    expect(result.json.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: inviter.id,
          registration_source: 'direct_or_unknown',
          inviter: null,
        }),
        expect.objectContaining({
          user_id: invitee.id,
          registration_source: 'invited',
          inviter: { user_id: inviter.id, username: inviter.username },
        }),
      ]),
    )
  })

  it('returns a zeroed no-wallet summary for an enterprise identity', async () => {
    const { id } = await createOperatorUser()
    await db.delete(creditAccounts).where(eq(creditAccounts.user_id, id))
    await db
      .insert(accountFacts)
      .values({ user_id: id, category: 'feishu_unmetered', created_at: Date.now() })

    const result = await request(
      'GET',
      `/internal/admin/private/billing/users?ids=${id}`,
      undefined,
      operatorHeaders,
    )

    expect(result.status).toBe(200)
    expect(result.json.summaries).toEqual([
      expect.objectContaining({
        user_id: id,
        subscription_balance: 0,
        recharge_balance: 0,
        subscription_expires_at: null,
        subscription: null,
      }),
    ])
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, id)),
    ).toHaveLength(0)
  })
})

describe('referral accounting lifecycle', () => {
  it('uses the submitted code, grants both spendable rewards once, and keeps only direct attribution', async () => {
    const { inviter, invitee, code } = await pair()
    expect(await account(inviter)).toMatchObject({ recharge_balance: 2_200 })
    expect(await account(invitee)).toMatchObject({ recharge_balance: 2_200 })
    expect(await summary(inviter)).toMatchObject({
      invitation_count: 1,
      reward_balance: 0,
      total_rewards: 200,
    })
    expect(await summary(invitee)).toMatchObject({
      invitation_count: 0,
      reward_balance: 0,
      total_rewards: 200,
    })
    const repeated = await Promise.all(Array.from({ length: 4 }, () => summary(inviter)))
    expect(repeated.map((value) => value.code)).toEqual([code, code, code, code])
    const nextCode = (await summary(invitee)).code
    const third = await signup(
      {
        username: `third-${randomUUID().slice(0, 10)}@example.com`,
        password,
        referral_code: nextCode,
      },
      { referer: `http://localhost/?ref=${code}` },
    )
    expect(third.status).toBe(201)
    if (!third.json.user) throw new Error('Missing third user')
    expect((await pay(third.json.user, 10_000)).status).toBe(200)
    expect(await summary(invitee)).toMatchObject({
      invitation_count: 1,
      reward_balance: 500,
      total_rewards: 900,
    })
    expect(await summary(inviter)).toMatchObject({
      invitation_count: 1,
      reward_balance: 0,
      total_rewards: 200,
    })
    const history = await request('GET', '/api/billing/referrals/rewards', undefined, {
      cookie: invitee.cookie,
    })
    expect(history.json.rewards).toEqual([
      expect.objectContaining({ credits: 500, status: 'available' }),
    ])
    expect(JSON.stringify(history.json)).not.toContain(third.json.user.id)
    expect(JSON.stringify(history.json)).not.toContain('amount_cents')
    expect(JSON.stringify(history.json)).not.toContain('user_id')
  })

  it('serializes duplicate signups and rolls back an overflowing registration before the user exists', async () => {
    const inviter = await createOperatorUser()
    const { code } = await summary(inviter)
    const body = {
      username: `race-${randomUUID().slice(0, 10)}@example.com`,
      password,
      referral_code: code,
    }
    const results = await Promise.all([signup(body), signup(body)])
    expect(results.map((result) => result.status).sort()).toEqual([201, 409])
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1, total_rewards: 200 })
    expect(
      (
        await request(
          'POST',
          `/internal/admin/private/billing/users/${inviter.id}/recharge`,
          {
            amount: MAX_CREDIT_BALANCE - 2_200,
            reason: 'fill account for boundary',
            payment: null,
          },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    const overflowing = {
      username: `full-${randomUUID().slice(0, 10)}@example.com`,
      password,
      referral_code: code,
    }
    const rejected = await signup(overflowing)
    expect(rejected.status).toBe(400)
    expect(rejected.json.error).toBe('registration_reward_unavailable')
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1, total_rewards: 200 })
    expect((await signup({ ...overflowing, referral_code: '' })).status).toBe(201)
  })

  it('settles the payer without crediting an existing inviter who no longer has a wallet', async () => {
    const { inviter, invitee } = await pair()
    await db.delete(creditAccounts).where(eq(creditAccounts.user_id, inviter.id))
    await db
      .insert(accountFacts)
      .values({ user_id: inviter.id, category: 'feishu_unmetered', created_at: Date.now() })
    const before = await db
      .select()
      .from(referralProfiles)
      .where(eq(referralProfiles.user_id, inviter.id))
    const operationId = randomUUID()
    expect((await pay(invitee, 10_000, operationId)).status).toBe(200)
    expect((await payments(invitee)).find((payment) => payment.id === operationId)).toMatchObject({
      reward_credits: 0,
    })
    expect(
      await db.select().from(referralProfiles).where(eq(referralProfiles.user_id, inviter.id)),
    ).toEqual(before)
    expect(
      await db.select().from(referralRewards).where(eq(referralRewards.source_id, operationId)),
    ).toEqual([])
    expect(
      await db.select().from(creditAccounts).where(eq(creditAccounts.user_id, inviter.id)),
    ).toEqual([])
  })

  it('rewards actual membership money and each paid renewal, but not grants or monthly entitlements', async () => {
    const { inviter, invitee } = await pair()
    const path = `/internal/admin/private/billing/users/${invitee.id}/subscriptions`
    const membership = {
      plan_id: 'starter',
      period_months: 1,
      starts_at: Date.now(),
      reason: 'actual collected amount',
    }
    const { grantSubscription } = await import('../../../modules/billing/commerce')
    for (const [periodMonths, amount] of [
      [1, 10000],
      [1, 8000],
      [12, 120000],
    ] as const) {
      const payment = { operation_id: randomUUID(), amount_cents: amount }
      await grantSubscription({
        userId: invitee.id,
        planId: membership.plan_id,
        periodMonths,
        startsAt: membership.starts_at,
        reason: membership.reason,
        payment,
      })
      expect(
        (
          await request(
            'POST',
            path,
            { ...membership, period_months: periodMonths, payment },
            operatorHeaders,
          )
        ).status,
      ).toBe(200)
    }
    expect(await summary(inviter)).toMatchObject({ reward_balance: 6_900, total_rewards: 7_100 })
    expect(
      (await request('POST', path, { ...membership, payment: null }, operatorHeaders)).status,
    ).toBe(200)
    expect(
      (
        await request(
          'POST',
          `/internal/admin/private/billing/users/${invitee.id}/recharge`,
          {
            amount: 9_999,
            reason: 'free compensation',
            payment: null,
          },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    await db
      .update(subscriptions)
      .set({ next_grant_at: Date.now() - 1 })
      .where(eq(subscriptions.user_id, invitee.id))
    expect(
      (
        await request(
          'POST',
          '/internal/admin/private/billing/maintenance',
          undefined,
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    await account(invitee)
    await account(invitee)
    expect(await summary(inviter)).toMatchObject({ reward_balance: 6_900, total_rewards: 7_100 })
    expect(await payments(invitee)).toHaveLength(3)
  })

  it('rounds once, deduplicates concurrent payments and freezes historical policy snapshots', async () => {
    const { inviter, invitee } = await pair()
    expect((await pay(invitee, 19, randomUUID(), 1)).status).toBe(200)
    expect(await summary(inviter)).toMatchObject({ reward_balance: 0 })
    expect((await pay(invitee, 20, randomUUID(), 1)).status).toBe(200)
    expect(await summary(inviter)).toMatchObject({ reward_balance: 1 })
    const operationId = randomUUID()
    const repeated = await Promise.all([
      pay(invitee, 10_000, operationId),
      pay(invitee, 10_000, operationId),
    ])
    expect(repeated.map((result) => result.status)).toEqual([200, 200])
    expect(await account(invitee)).toMatchObject({ recharge_balance: 6_202 })
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, paid_reward_basis_points: 1000, credits_per_yuan: 200.125 },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    expect((await pay(invitee, 10_000, operationId)).status).toBe(200)
    expect((await pay(invitee, 10_001, operationId)).status).toBe(409)
    expect((await pay(invitee, 10_000)).status).toBe(200)
    expect(await summary(inviter)).toMatchObject({ reward_balance: 2_502, total_rewards: 2_702 })
    expect((await payments(invitee)).find((payment) => payment.id === operationId)).toMatchObject({
      paid_reward_basis_points: 500,
      credits_per_yuan: 100,
      reward_credits: 500,
    })
    const firstPage = await request('GET', '/api/billing/referrals/rewards?limit=1', undefined, {
      cookie: inviter.cookie,
    })
    const secondPage = await request(
      'GET',
      `/api/billing/referrals/rewards?offset=${firstPage.json.next_offset}&limit=1`,
      undefined,
      { cookie: inviter.cookie },
    )
    expect(firstPage.json.rewards?.[0].credits).toBe(2_001)
    expect(secondPage.json.rewards?.[0].credits).toBe(500)
    expect(secondPage.json.rewards?.[0].id).not.toBe(firstPage.json.rewards?.[0].id)
  })

  it('transfers positive balances once and an old request cannot consume subsequently earned credits', async () => {
    const { inviter, invitee } = await pair()
    expect((await pay(invitee, 10_000)).status).toBe(200)
    const operationId = randomUUID()
    expect(
      (await request('POST', '/api/billing/referrals/transfer', { operation_id: operationId }))
        .status,
    ).toBe(401)
    expect(
      (await request('PUT', policyPath, defaultPolicy, { cookie: inviter.cookie })).status,
    ).toBe(401)
    const results = await Promise.all([
      transfer(inviter, operationId),
      transfer(inviter, operationId),
    ])
    expect(results.map((result) => result.status)).toEqual([200, 200])
    expect(await account(inviter)).toMatchObject({ recharge_balance: 2_700 })
    expect(await summary(inviter)).toMatchObject({
      invitation_count: 1,
      reward_balance: 0,
      total_rewards: 700,
    })
    expect((await transfer(inviter, randomUUID())).json.error).toBe('no_rewards')
    expect((await transfer(invitee, operationId)).json.error).toBe('transfer_conflict')
    expect((await pay(invitee, 20, randomUUID(), 1)).status).toBe(200)
    const retried = await transfer(inviter, operationId)
    expect(retried.json.transferred_credits).toBe(500)
    expect(retried.json.summary?.reward_balance).toBe(1)
    const competing = await Promise.all([
      transfer(inviter, randomUUID()),
      transfer(inviter, randomUUID()),
    ])
    expect(competing.map((result) => result.status).sort()).toEqual([200, 409])
    expect(await account(inviter)).toMatchObject({ recharge_balance: 2_701 })
    expect(await summary(inviter)).toMatchObject({ reward_balance: 0, total_rewards: 701 })
    const history = await request('GET', '/api/billing/referrals/rewards', undefined, {
      cookie: inviter.cookie,
    })
    expect(history.json.rewards?.map((reward) => reward.status)).toEqual([
      'transferred',
      'transferred',
    ])
  })

  it('rolls back payment, benefit and reward on audit failure and preserves balances on overflow', async () => {
    const { inviter, invitee } = await pair()
    const operationId = randomUUID()
    await db.execute(
      sql`ALTER TABLE operator_audits ADD CONSTRAINT referral_fixture_audit_failure CHECK (action <> 'billing.payment.confirm') NOT VALID`,
    )
    try {
      expect((await pay(invitee, 10_000, operationId)).status).toBe(500)
      expect(await account(invitee)).toMatchObject({ recharge_balance: 2_200 })
      expect(await summary(inviter)).toMatchObject({ reward_balance: 0, total_rewards: 200 })
      expect(await payments(invitee)).toEqual([])
    } finally {
      await db.execute(
        sql`ALTER TABLE operator_audits DROP CONSTRAINT referral_fixture_audit_failure`,
      )
    }
    expect((await pay(invitee, 10_000, operationId)).status).toBe(200)
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, paid_reward_basis_points: 10000 },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    expect((await pay(invitee, MAX_CREDIT_BALANCE - 500, randomUUID(), 1)).status).toBe(200)
    expect((await pay(invitee, 1, randomUUID(), 1)).json.error).toBe('credit_balance_overflow')
    expect(await payments(invitee)).toHaveLength(2)
    expect(await account(invitee)).toMatchObject({ recharge_balance: 6_201 })
    expect((await transfer(inviter, randomUUID())).json.error).toBe('credit_balance_overflow')
    expect(await account(inviter)).toMatchObject({ recharge_balance: 2_200 })
    expect(await summary(inviter)).toMatchObject({ reward_balance: MAX_CREDIT_BALANCE })
  })

  it('independently disables each reward, retains attribution and keeps old rewards withdrawable', async () => {
    expect(
      (
        await request(
          'PUT',
          policyPath,
          {
            ...defaultPolicy,
            inviter_registration_credits: 0,
            invitee_registration_credits: 333,
            paid_reward_basis_points: 0,
          },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    const { inviter, invitee, code } = await pair()
    expect(await account(inviter)).toMatchObject({ recharge_balance: 2_000 })
    expect(await account(invitee)).toMatchObject({ recharge_balance: 2_333 })
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1, total_rewards: 0 })
    expect(await summary(invitee)).toMatchObject({ total_rewards: 333 })
    expect((await pay(invitee, 10_000)).status).toBe(200)
    expect(await summary(inviter)).toMatchObject({ reward_balance: 0 })
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, inviter_registration_credits: 444, invitee_registration_credits: 0 },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    const next = await invitedUser(code)
    expect(await account(next)).toMatchObject({ recharge_balance: 2_000 })
    expect(await summary(next)).toMatchObject({ total_rewards: 0 })
    expect((await pay(invitee, 10_000)).status).toBe(200)
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, paid_reward_basis_points: 0 },
          operatorHeaders,
        )
      ).status,
    ).toBe(200)
    expect((await transfer(inviter, randomUUID())).json.transferred_credits).toBe(500)
    expect(await summary(inviter)).toMatchObject({
      invitation_count: 2,
      reward_balance: 0,
      total_rewards: 944,
    })
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, credits_per_yuan: 0.00001 },
          operatorHeaders,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await request(
          'PUT',
          policyPath,
          { ...defaultPolicy, inviter_registration_credits: -1 },
          operatorHeaders,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400)
    expect(
      (await request('GET', policyPath, undefined, operatorHeaders)).json.paid_reward_basis_points,
    ).toBe(0)
  })

  it('preserves Google attribution, rejects changed state and never rebinds returning users or linked identities', async () => {
    const inviter = await createOperatorUser()
    const { code } = await summary(inviter)
    let subject = randomUUID()
    setOAuthFetchForTesting((async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://oauth2.googleapis.com/token')
        return Response.json({ access_token: 'referral-token' })
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
        return Response.json({
          sub: subject,
          email: `${subject}@example.com`,
          email_verified: true,
          name: 'Invited creator',
        })
      throw new Error(`Unexpected OAuth request: ${url}`)
    }) as typeof fetch)
    async function googleFlow(ref: string, linkingCookie?: string) {
      const start = await request(
        'GET',
        `/api/auth/oauth/google/${linkingCookie ? 'link' : 'start'}?ref=${encodeURIComponent(ref)}`,
        undefined,
        linkingCookie ? { cookie: linkingCookie } : {},
      )
      expect(start.status).toBe(302)
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
      const stateCookie = start.headers
        .getSetCookie()
        .find((value) => value.startsWith('image_playground_oauth_state='))
        ?.split(';')[0]
      if (!state || !stateCookie) throw new Error('Missing protected OAuth state')
      const callbackPath = `/api/auth/oauth/google/callback?code=fixture&state=${encodeURIComponent(state)}`
      expect(
        (await request('GET', `${callbackPath}tampered`, undefined, { cookie: stateCookie }))
          .status,
      ).toBe(403)
      return request('GET', callbackPath, undefined, {
        cookie: [linkingCookie, stateCookie].filter(Boolean).join('; '),
      })
    }
    const invalid = await googleFlow('invalid-code')
    expect(new URL(invalid.headers.get('location') ?? '').searchParams.get('auth_error')).toBe(
      'invalid_referral_code',
    )
    const registered = await googleFlow(code)
    const cookie = registered.headers
      .getSetCookie()
      .find((value) => value.startsWith('image_playground_session='))
      ?.split(';')[0]
    if (!cookie) throw new Error('Missing Google session')
    expect(await account({ cookie })).toMatchObject({ recharge_balance: 2_200 })
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1, total_rewards: 200 })
    const returning = await googleFlow('invalid-code')
    expect(new URL(returning.headers.get('location') ?? '').searchParams.has('auth_error')).toBe(
      false,
    )
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1, total_rewards: 200 })
    const existing = await createOperatorUser()
    subject = randomUUID()
    expect((await googleFlow(code, existing.cookie)).status).toBe(302)
    expect(await summary(existing)).toMatchObject({ total_rewards: 0 })
    expect(await account(existing)).toMatchObject({ recharge_balance: 2_000 })
    expect(await summary(inviter)).toMatchObject({ invitation_count: 1 })
  })

  it('keeps referral writes disabled with billing while ordinary registration still works', async () => {
    const user = await createOperatorUser()
    const capabilities = config.operator.capabilities as Record<string, boolean>
    capabilities['billing:credits'] = false
    try {
      expect(
        (await request('GET', '/api/billing/referrals', undefined, { cookie: user.cookie })).status,
      ).toBe(404)
      expect((await transfer(user, randomUUID())).status).toBe(404)
      expect(
        (
          await signup({
            username: `off-${randomUUID().slice(0, 10)}@example.com`,
            password,
            referral_code: 'invalid-code',
          })
        ).status,
      ).toBe(201)
    } finally {
      capabilities['billing:credits'] = true
    }
    expect(await summary(user)).toMatchObject({
      invitation_count: 0,
      reward_balance: 0,
      total_rewards: 0,
    })
  })
})
