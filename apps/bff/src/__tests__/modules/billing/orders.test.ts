import { afterAll, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('billing_orders')
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.INTERNAL_API_TOKEN = 'orders-test-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(process.env.DATABASE_URL)
const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close, db } = await import('../../../db/client')
const { accountFacts, creditAccounts, purchaseOrders, unmeteredEntitlements } = await import(
  '@image-playground/db/billing'
)
const { addCalendarMonths } = await import('../../../modules/billing/calculations')
afterAll(close)
const admin = {
  authorization: 'Bearer orders-test-token',
  'x-admin-operator': 'operator@example.com',
}
async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = admin,
) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  return {
    status: response.status,
    json: response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : { error: await response.text() },
    headers: response.headers,
  }
}
async function fixture(withSubscription = true, planName?: string) {
  const username = `order-${randomUUID().slice(0, 8)}`
  const user = await request('POST', '/internal/admin/users', {
    username,
    password: 'orders-fixture-pass',
  })
  const login = await request(
    'POST',
    '/api/auth/login',
    { username, password: 'orders-fixture-pass' },
    {},
  )
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const catalog = await request('GET', '/internal/admin/private/billing/catalog')
  const plan = catalog.json.plans.find(
    (entry: { name: string; active: boolean }) =>
      entry.active && (!planName || entry.name === planName),
  )
  if (withSubscription)
    await request(
      'POST',
      `/internal/admin/private/billing/users/${user.json.user.id}/subscriptions`,
      {
        plan_id: plan.id,
        period_months: 1,
        starts_at: Date.now(),
        reason: 'fixture gift',
        payment: null,
      },
    )
  const settings = await request('PUT', '/internal/admin/private/billing/settings', {
    contact_wechat: 'support',
    payment_qr_url: '/pay.png',
    contact_qr_url: '/contact.png',
    guidance: '',
    payment_channel: 'wechat',
    receiving_account: 'fixture-account',
    payments_enabled: true,
  })
  expect(settings.status).toBe(200)
  return { cookie, plan, userId: user.json.user.id }
}
it('creates an owned, locked-price renewal and replays the same request', async () => {
  const { cookie, plan } = await fixture()
  const input = { plan_id: plan.id, period_months: 1, request_id: randomUUID() }
  const created = await request('POST', '/api/billing/orders', input, { cookie })
  expect(created.status).toBe(200)
  expect(created.json.status).toBe('pending')
  expect(created.json.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  expect(created.json.amount_cents).toBe(
    plan.prices.find((p: { period_months: number }) => p.period_months === 1).effective_price_cents,
  )
  expect((await request('POST', '/api/billing/orders', input, { cookie })).json.id).toBe(
    created.json.id,
  )
  expect(
    (await request('GET', `/api/billing/orders/${created.json.id}`, undefined, {})).status,
  ).toBe(401)
})
it('rejects new and pending legacy paid orders for enterprise accounts without wallets', async () => {
  const { cookie, userId, plan } = await fixture(false)
  const input = { plan_id: plan.id, period_months: 1, request_id: randomUUID() }
  const legacy = await request('POST', '/api/billing/orders', input, { cookie })
  expect(legacy.status).toBe(200)
  await db.delete(creditAccounts).where(eq(creditAccounts.user_id, userId))
  await db.insert(accountFacts).values({
    user_id: userId,
    category: 'feishu_unmetered',
    created_at: Date.now(),
  })
  const originalFetch = globalThis.fetch
  let paymentCalls = 0
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      paymentCalls += 1
      return originalFetch(...args)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const before = await db
      .select({ id: purchaseOrders.id, status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.user_id, userId))
    for (const requestId of [input.request_id, randomUUID()]) {
      const rejected = await request(
        'POST',
        '/api/billing/orders',
        { ...input, request_id: requestId },
        { cookie },
      )
      expect(rejected.status).toBe(403)
      expect(rejected.json).toEqual({ error: 'billing_account_unavailable' })
    }
    expect(paymentCalls).toBe(0)
    const after = await db
      .select({ id: purchaseOrders.id, status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.user_id, userId))
    expect(after).toEqual(before)
  } finally {
    globalThis.fetch = originalFetch
  }
})

it('continues issuing paid orders for enterprise accounts with existing wallets', async () => {
  const { cookie, userId, plan } = await fixture()
  await db.insert(accountFacts).values({
    user_id: userId,
    category: 'feishu_unmetered',
    created_at: Date.now(),
  })
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.status).toBe(200)
  expect(created.json.status).toBe('pending')
})

it('rejects payable orders while an enterprise wallet holder has active unmetered entitlement', async () => {
  const { cookie, userId, plan } = await fixture()
  await db
    .insert(accountFacts)
    .values({ user_id: userId, category: 'feishu_unmetered', created_at: Date.now() })
  await db.insert(unmeteredEntitlements).values({
    user_id: userId,
    enabled: true,
    daily_quota: 20,
    guaranteed_concurrency: 2,
    idle_concurrency: 0,
    updated_at: Date.now(),
  })
  for (const input of [
    { plan_id: plan.id, period_months: 1 },
    { kind: 'recharge', amount_cents: 1000 },
  ]) {
    const result = await request(
      'POST',
      '/api/billing/orders',
      { ...input, request_id: randomUUID() },
      { cookie },
    )
    expect(result.status).toBe(403)
    expect(result.json.error).toBe('billing_account_unavailable')
  }
  expect(await db.select().from(purchaseOrders).where(eq(purchaseOrders.user_id, userId))).toEqual(
    [],
  )
})

it('confirms a real receipt before a user claim and prevents duplicate fulfilment', async () => {
  const { cookie, plan, userId } = await fixture()
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  const order = created.json
  const before = await request('GET', `/internal/admin/private/billing/users/${userId}`)
  const receipt = {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    transaction_id: randomUUID(),
    amount_cents: order.amount_cents,
    received_at: Date.now(),
    note: 'matched order remark',
  }
  const results = await Promise.all([
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt),
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt),
  ])
  expect(results.map((r) => ({ status: r.status, error: r.json.error }))).toEqual([
    { status: 200, error: undefined },
    { status: 200, error: undefined },
  ])
  expect(results[0]!.json.status).toBe('completed')
  const after = await request('GET', `/internal/admin/private/billing/users/${userId}`)
  expect(after.json.payments).toHaveLength(1)
  expect(after.json.subscription.ends_at).toBeGreaterThan(before.json.subscription.ends_at)
  const second = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  const duplicate = await request(
    'POST',
    `/internal/admin/private/billing/orders/${second.json.id}/confirm`,
    receipt,
  )
  expect(duplicate.status).toBe(409)
  expect(duplicate.json.order_id).toBe(order.id)
  expect(
    (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json.payments,
  ).toHaveLength(1)
})
it('notifies once at creation and never again for a claim or confirmation', async () => {
  const { cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const originalFetch = globalThis.fetch
  const deliveries: string[] = []
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://example.test/feishu'
  process.env.ADMIN_FRONTEND_ORIGIN = 'https://admin.example.test'
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      deliveries.push(String(init?.body))
      return Response.json({ code: 0 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const { privateTaskHooks } = await import('../../../modules/billing/hooks')
    await privateTaskHooks.runMaintenance(Date.now())
    expect(deliveries).toHaveLength(0)
    await privateTaskHooks.runWorkerMaintenance?.(Date.now())
    expect(deliveries.some((message) => message.includes(order.id))).toBe(true)
    const count = deliveries.length
    expect(
      (await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })).status,
    ).toBe(200)
    expect(
      (await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })).status,
    ).toBe(200)
    expect(
      (
        await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, {
          channel: 'wechat',
          receiving_account: 'fixture-account',
          payment_code_id: order.payment_code.id,
          transaction_id: randomUUID(),
          amount_cents: order.amount_cents,
          received_at: Date.now(),
          note: 'matched',
        })
      ).status,
    ).toBe(200)
    await privateTaskHooks.runWorkerMaintenance?.(Date.now())
    expect(deliveries).toHaveLength(count)
    expect(deliveries.join('')).not.toContain('user_id')
    expect(deliveries.join('')).not.toContain('operator@example.com')
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.OPS_ALERT_WEBHOOK_URL
    delete process.env.ADMIN_FRONTEND_ORIGIN
  }
})
it('finds receipts in Admin, records unmatched notes and reopens the original order', async () => {
  const { cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const found = await request('GET', `/internal/admin/private/billing/orders?q=${order.code}`)
  expect(found.status).toBe(200)
  expect(found.json.orders.map((o: { id: string }) => o.id)).toEqual([order.id])
  expect(
    (
      await request('POST', `/internal/admin/private/billing/orders/${order.id}/review`, {
        action: 'note',
        note: 'missing transfer remark',
      })
    ).status,
  ).toBe(200)
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json
      .review_note,
  ).toBe('')
  const minute = Math.floor(order.created_at / 60000) * 60000
  const candidates = await request(
    'GET',
    `/internal/admin/private/billing/orders?amount_cents=${order.amount_cents}&received_at=${minute}`,
  )
  expect(candidates.json.orders.some((o: { id: string }) => o.id === order.id)).toBe(true)
  await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })
  const reject = await request(
    'POST',
    `/internal/admin/private/billing/orders/${order.id}/review`,
    { action: 'reject', rejection_message: '未匹配到付款，请联系客服', note: 'unmatched receipt' },
  )
  expect(reject.json.status).toBe('rejected')
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json
      .review_note,
  ).toBe('未匹配到付款，请联系客服')
  expect(
    (await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })).status,
  ).toBe(409)
  const reopened = await request(
    'POST',
    `/internal/admin/private/billing/orders/${order.id}/review`,
    { action: 'reopen', note: 'transaction located' },
  )
  expect(reopened.json.status).toBe('review')
  expect(reopened.json.id).toBe(order.id)
  expect(reopened.json.history.map((h: { action: string }) => h.action)).toEqual([
    'note',
    'reject',
    'reopen',
  ])
})
it('closes legacy paid writes while allowing historical payment replay and free corrections', async () => {
  const { userId, plan } = await fixture()
  const body = {
    plan_id: plan.id,
    period_months: 1,
    starts_at: Date.now(),
    reason: 'historical transfer',
    payment: { operation_id: randomUUID(), amount_cents: 4900 },
  }
  const path = `/internal/admin/private/billing/users/${userId}/subscriptions`
  expect((await request('POST', path, body)).json.error).toBe('orders_required')
  const { grantSubscription } = await import('../../../modules/billing/commerce')
  await grantSubscription({
    userId,
    planId: plan.id,
    periodMonths: 1,
    startsAt: body.starts_at,
    reason: body.reason,
    payment: body.payment,
    operatorId: 'historical-operator',
  })
  expect((await request('POST', path, body)).status).toBe(200)
  expect(
    (
      await request('POST', `/internal/admin/private/billing/users/${userId}/recharge`, {
        amount: 100,
        reason: 'new paid recharge',
        payment: { operation_id: randomUUID(), amount_cents: 100 },
      })
    ).json.error,
  ).toBe('orders_required')
  expect(
    (
      await request('POST', `/internal/admin/private/billing/users/${userId}/recharge`, {
        amount: 100,
        reason: 'free correction',
        payment: null,
      })
    ).status,
  ).toBe(200)
})
it('versions changed entitlements without rewriting existing subscriptions or locked orders', async () => {
  const { userId, cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const changed = await request('PUT', `/internal/admin/private/billing/plans/${plan.id}`, {
    name: plan.name,
    monthly_credits: plan.monthly_credits + 100,
    active: true,
    sort_order: plan.sort_order,
    prices: plan.prices,
  })
  expect(changed.status).toBe(200)
  expect(changed.json.plan_id).not.toBe(plan.id)
  const account = await request('GET', `/internal/admin/private/billing/users/${userId}`)
  expect(account.json.subscription.plan.monthly_credits).toBe(plan.monthly_credits)
  expect(
    (
      await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, {
        channel: 'wechat',
        receiving_account: 'fixture-account',
        payment_code_id: order.payment_code.id,
        transaction_id: randomUUID(),
        amount_cents: order.amount_cents,
        received_at: Date.now(),
        note: 'locked quote',
      })
    ).status,
  ).toBe(200)
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json.plan_id,
  ).toBe(plan.id)
  const now = Date.now
  Date.now = () => order.created_at + 32 * 86400_000
  try {
    expect(
      (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json.account
        .subscription_balance,
    ).toBe(plan.monthly_credits)
  } finally {
    Date.now = now
  }
})
it('rolls back receipt, payment and renewal together if the audit write fails', async () => {
  const { userId, cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const { db } = await import('../../../db/client')
  const { sql } = await import('drizzle-orm')
  await db.execute(
    sql`ALTER TABLE operator_audits ADD CONSTRAINT orders_fixture_failure CHECK(action <> 'billing.subscription.renew') NOT VALID`,
  )
  const receipt = {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    transaction_id: randomUUID(),
    amount_cents: order.amount_cents,
    received_at: Date.now(),
    note: 'verified',
  }
  try {
    expect(
      (await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt))
        .status,
    ).toBe(500)
  } finally {
    await db.execute(sql`ALTER TABLE operator_audits DROP CONSTRAINT orders_fixture_failure`)
  }
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.subscription.ends_at).toBe(before.subscription.ends_at)
  expect(after.payments).toHaveLength(0)
  expect(
    (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json.receipt,
  ).toBeNull()
  expect(
    (await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt))
      .status,
  ).toBe(200)
})
it('keeps a review open past the payment window and enforces order ownership', async () => {
  const { cookie, plan } = await fixture(),
    other = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie: other.cookie }))
      .status,
  ).toBe(404)
  await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })
  const now = Date.now
  Date.now = () => order.expires_at + 3600_000
  try {
    expect(
      (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json.status,
    ).toBe('review')
  } finally {
    Date.now = now
  }
})
it('locks the sale price, expires only unclaimed orders, and accepts late claims through Admin', async () => {
  const { userId, cookie, plan } = await fixture()
  await request('PUT', `/internal/admin/private/billing/plans/${plan.id}`, {
    name: plan.name,
    monthly_credits: plan.monthly_credits,
    active: true,
    sort_order: plan.sort_order,
    prices: [
      {
        period_months: 1,
        original_price_cents: 4900,
        discount_price_cents: 3900,
        discount_ends_at: Date.now() + 10000,
      },
    ],
  })
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  expect(order.amount_cents).toBe(3900)
  const now = Date.now
  Date.now = () => order.expires_at + 3600000
  try {
    expect(
      (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json.status,
    ).toBe('expired')
    expect(
      (await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })).status,
    ).toBe(409)
    expect(
      (
        await request('POST', `/internal/admin/private/billing/orders/${order.id}/review`, {
          action: 'reopen',
          note: 'paid during quote window; claim arrived late',
        })
      ).status,
    ).toBe(200)
    const paid = await request(
      'POST',
      `/internal/admin/private/billing/orders/${order.id}/confirm`,
      {
        channel: 'wechat',
        receiving_account: 'fixture-account',
        payment_code_id: order.payment_code.id,
        transaction_id: randomUUID(),
        amount_cents: 3900,
        received_at: order.created_at + 1000,
        note: 'matched transfer reference',
      },
    )
    expect(paid.status).toBe(200)
    expect(
      (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json.payments[0]
        .amount_cents,
    ).toBe(3900)
  } finally {
    Date.now = now
  }
})
it('pauses QR display and preserves every displayed code version when replacing a code', async () => {
  const { cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const settings = {
    contact_wechat: 'support',
    payment_qr_url: '/pay-new.png',
    contact_qr_url: '/contact.png',
    guidance: '',
    payment_channel: 'wechat',
    receiving_account: 'fixture-account',
    payments_enabled: false,
  }
  await request('PUT', '/internal/admin/private/billing/settings', settings)
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json
      .payment_available,
  ).toBe(false)
  expect(
    (await request('POST', `/api/billing/orders/${order.id}/refresh-code`, {}, { cookie })).status,
  ).toBe(409)
  await request('PUT', '/internal/admin/private/billing/settings', {
    ...settings,
    payments_enabled: true,
  })
  const changed = await request(
    'POST',
    `/api/billing/orders/${order.id}/refresh-code`,
    {},
    { cookie },
  )
  expect(changed.json.payment_history.map((v: { url: string }) => v.url)).toEqual([
    '/pay.png',
    '/pay-new.png',
  ])
  expect(changed.json.payment_available).toBe(true)
})
it('marks missing notification configuration as failed without retrying an existing order', async () => {
  const { cookie, plan } = await fixture()
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const { privateTaskHooks } = await import('../../../modules/billing/hooks')
  await privateTaskHooks.runWorkerMaintenance?.(Date.now())
  expect(
    (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json
      .notification_status,
  ).toBe('failed')
  await privateTaskHooks.runWorkerMaintenance?.(Date.now())
  expect(
    (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json
      .notification_status,
  ).toBe('failed')
})

it('locks recharge credits at 400 per yuan and confirms concurrent receipts once', async () => {
  const { cookie, userId } = await fixture()
  const input = { kind: 'recharge', amount_cents: 10000, request_id: randomUUID() }
  const created = await request('POST', '/api/billing/orders', input, { cookie })
  expect(created.status).toBe(200)
  const order = created.json
  expect(order.kind).toBe('recharge')
  expect(order.recharge_credits).toBe(40000)
  expect(order.plan_id).toBeNull()
  expect((await request('POST', '/api/billing/orders', input, { cookie })).json.id).toBe(order.id)
  expect(
    (await request('POST', '/api/billing/orders', { ...input, amount_cents: 20000 }, { cookie }))
      .status,
  ).toBe(409)
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const receipt = {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    transaction_id: randomUUID(),
    amount_cents: 10000,
    received_at: Date.now(),
    note: 'recharge receipt',
  }
  const results = await Promise.all([
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt),
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt),
  ])
  expect(results.map((r) => r.status)).toEqual([200, 200])
  expect(results[0]!.json.ends_at).toBeNull()
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.account.recharge_balance - before.account.recharge_balance).toBe(40000)
  expect(after.subscription.ends_at).toBe(before.subscription.ends_at)
  expect(after.payments.filter((p: { kind: string }) => p.kind === 'recharge')).toHaveLength(1)
  const renewal = (
    await request(
      'POST',
      '/api/billing/orders',
      { plan_id: before.subscription.plan_id, period_months: 1, request_id: randomUUID() },
      { cookie },
    )
  ).json
  const duplicate = await request(
    'POST',
    `/internal/admin/private/billing/orders/${renewal.id}/confirm`,
    { ...receipt, amount_cents: renewal.amount_cents },
  )
  expect(duplicate.json.error).toBe('receipt_already_used')
})
it('rejects fractional yuan and overflowing recharge quotes', async () => {
  const { cookie } = await fixture()
  for (const amount of [0, -100, 150, 500, 2000, 715827900]) {
    const result = await request(
      'POST',
      '/api/billing/orders',
      { kind: 'recharge', amount_cents: amount, request_id: randomUUID() },
      { cookie },
    )
    expect(result.status).toBe(400)
  }
})

it('recharges an invited user without a plan and rolls back referral rewards on fulfilment failure', async () => {
  const inviter = await fixture(false)
  await request('PUT', '/internal/admin/private/billing/referrals/policy', {
    inviter_registration_credits: 200,
    invitee_registration_credits: 200,
    paid_reward_basis_points: 500,
    credits_per_yuan: 100,
  })
  const code = (
    await request('GET', '/api/billing/referrals', undefined, { cookie: inviter.cookie })
  ).json.code
  const registered = await request(
    'POST',
    '/api/auth/register',
    {
      username: `recharge-${randomUUID().slice(0, 8)}@example.com`,
      password: 'recharge-fixture-pass',
      referral_code: code,
    },
    { 'cf-connecting-ip': '10.99.1.1' },
  )
  expect(registered.status).toBe(201)
  const cookie = registered.headers.get('set-cookie')!.split(';')[0]!
  const userId = registered.json.user.id
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      { kind: 'recharge', amount_cents: 5000, request_id: randomUUID() },
      { cookie },
    )
  ).json
  expect(order.recharge_credits).toBe(20000)
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(before.subscription).toBeNull()
  const rewardBefore = (
    await request('GET', '/api/billing/referrals', undefined, { cookie: inviter.cookie })
  ).json.reward_balance
  const receipt = {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    transaction_id: randomUUID(),
    amount_cents: 5000,
    received_at: Date.now(),
    note: 'recharge verified',
  }
  const { db } = await import('../../../db/client')
  const { sql } = await import('drizzle-orm')
  await db.execute(
    sql`ALTER TABLE operator_audits ADD CONSTRAINT recharge_fixture_failure CHECK(action <> 'billing.payment.confirm') NOT VALID`,
  )
  try {
    expect(
      (await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt))
        .status,
    ).toBe(500)
  } finally {
    await db.execute(sql`ALTER TABLE operator_audits DROP CONSTRAINT recharge_fixture_failure`)
  }
  const failed = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(failed.account.recharge_balance).toBe(before.account.recharge_balance)
  expect(failed.payments).toHaveLength(0)
  expect(
    (await request('GET', `/api/billing/orders/${order.id}`, undefined, { cookie })).json.status,
  ).toBe('pending')
  expect(
    (await request('GET', '/api/billing/referrals', undefined, { cookie: inviter.cookie })).json
      .reward_balance,
  ).toBe(rewardBefore)
  expect(
    (await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt))
      .status,
  ).toBe(200)
  expect(
    (await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, receipt))
      .status,
  ).toBe(200)
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.subscription).toBeNull()
  expect(after.account.recharge_balance - before.account.recharge_balance).toBe(20000)
  expect(
    (await request('GET', '/api/billing/referrals', undefined, { cookie: inviter.cookie })).json
      .reward_balance,
  ).toBe(rewardBefore + 250)
})

async function catalogPlan(id: string) {
  const catalog = await request('GET', '/internal/admin/private/billing/catalog')
  const plan = catalog.json.plans.find((entry: { id: string }) => entry.id === id)
  expect(plan?.id).toBe(id)
  return plan
}
// 前面的用例会把权益改成新版本 id，按档位名找当前在售的那一版。
async function activePlan(name: string) {
  const catalog = await request('GET', '/internal/admin/private/billing/catalog')
  const plan = catalog.json.plans.find(
    (entry: { name: string; active: boolean }) => entry.active && entry.name === name,
  )
  expect(plan?.name).toBe(name)
  return plan
}
function monthCents(plan: {
  prices: Array<{ period_months: number; effective_price_cents: number }>
}) {
  return plan.prices.find((price) => price.period_months === 1)!.effective_price_cents
}
async function pay(order: { id: string; payment_code: { id: string }; amount_cents: number }) {
  return request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    transaction_id: randomUUID(),
    amount_cents: order.amount_cents,
    received_at: Date.now(),
    note: 'verified',
  })
}
// 订单接口不返回 starts_at，订单周期直接读库断言。
async function orderPeriod(id: string) {
  const { db } = await import('../../../db/client')
  const { eq } = await import('drizzle-orm')
  const { purchaseOrders } = await import('@image-playground/db/billing')
  const [row] = await db
    .select({ starts_at: purchaseOrders.starts_at, ends_at: purchaseOrders.ends_at })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
  return row
}
// 只读库里的当前订阅，不经过会顺带换档的接口。
async function activeSubscriptionRow(userId: string) {
  const { db } = await import('../../../db/client')
  const { and, eq } = await import('drizzle-orm')
  const { subscriptions } = await import('@image-playground/db/billing')
  const [row] = await db
    .select({
      plan_id: subscriptions.plan_id,
      starts_at: subscriptions.starts_at,
      ends_at: subscriptions.ends_at,
      scheduled_plan_id: subscriptions.scheduled_plan_id,
      scheduled_period_months: subscriptions.scheduled_period_months,
      scheduled_effective_at: subscriptions.scheduled_effective_at,
      scheduled_order_id: subscriptions.scheduled_order_id,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.user_id, userId), eq(subscriptions.status, 'active')))
  return row
}
function subscriptionGrants(
  snapshot: { ledger: Array<{ entry_type: string; bucket: string; amount: number }> },
  amount?: number,
) {
  return snapshot.ledger.filter(
    (entry) =>
      entry.entry_type === 'grant' &&
      entry.bucket === 'subscription' &&
      (amount === undefined || entry.amount === amount),
  )
}

it('opens a first subscription purchase when the user has no plan', async () => {
  const { cookie, userId } = await fixture(false)
  const plan = await catalogPlan('professional')
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.status).toBe(200)
  expect(created.json.subscription_action).toBe('grant')
  expect(created.json.amount_cents).toBe(monthCents(plan))
  expect((await pay(created.json)).status).toBe(200)
  const account = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(account.subscription.plan_id).toBe(plan.id)
  expect(account.subscription.plan.id).toBe(plan.id)
  expect(account.subscription.scheduled_change).toBeNull()
  expect(account.account.subscription_balance).toBe(plan.monthly_credits)
  expect(subscriptionGrants(account, plan.monthly_credits)).toHaveLength(1)
})

async function spendPlanCredits(userId: string, amount: number) {
  const spent = await request(
    'POST',
    `/internal/admin/private/billing/users/${userId}/subscription-credits`,
    { amount: -amount, reason: 'fixture usage' },
  )
  expect(spent.status).toBe(200)
}

it('renews with spent plan credits: grants the month at once and moves the grant day to today', async () => {
  const { cookie, userId, plan } = await fixture()
  await spendPlanCredits(userId, plan.monthly_credits)
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(before.account.subscription_balance).toBe(0)
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.json.subscription_action).toBe('renew')
  const paidAt = Date.now()
  expect((await pay(created.json)).status).toBe(200)
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.subscription.plan_id).toBe(before.subscription.plan_id)
  expect(after.subscription.ends_at).toBe(addCalendarMonths(before.subscription.ends_at, 1))
  expect(after.account.subscription_balance).toBe(plan.monthly_credits)
  expect(subscriptionGrants(after, plan.monthly_credits)).toHaveLength(
    subscriptionGrants(before, plan.monthly_credits).length + 1,
  )
  expect(after.account.subscription_expires_at).toBeGreaterThanOrEqual(addCalendarMonths(paidAt, 1))
  expect(after.account.subscription_expires_at).toBeLessThanOrEqual(
    addCalendarMonths(Date.now(), 1),
  )
  expect(after.subscription.next_grant_at).toBe(after.account.subscription_expires_at)
  expect(after.subscription.scheduled_change).toBeNull()
})

it('renews without replacing a plan balance that is already full', async () => {
  const { cookie, userId, plan } = await fixture()
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(before.account.subscription_balance).toBe(plan.monthly_credits)
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.json.subscription_action).toBe('renew')
  expect((await pay(created.json)).status).toBe(200)
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.subscription.ends_at).toBe(addCalendarMonths(before.subscription.ends_at, 1))
  expect(after.account.subscription_balance).toBe(before.account.subscription_balance)
  expect(after.account.subscription_expires_at).toBe(before.account.subscription_expires_at)
  expect(after.subscription.next_grant_at).toBe(before.subscription.next_grant_at)
  expect(subscriptionGrants(after)).toHaveLength(subscriptionGrants(before).length)
  expect(after.subscription.scheduled_change).toBeNull()
})

it('adjusts plan credits on the plan bucket with the existing expiry', async () => {
  const { userId, plan } = await fixture()
  await spendPlanCredits(userId, plan.monthly_credits)
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const path = `/internal/admin/private/billing/users/${userId}/subscription-credits`
  const granted = await request('POST', path, { amount: 1234, reason: 'renewal credits missing' })
  expect(granted.status).toBe(200)
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.account.subscription_balance).toBe(1234)
  expect(after.account.recharge_balance).toBe(before.account.recharge_balance)
  expect(after.account.subscription_expires_at).toBe(before.account.subscription_expires_at)
  expect(
    after.ledger.find((entry: { note: string | null }) => entry.note === 'renewal credits missing'),
  ).toMatchObject({ bucket: 'subscription', entry_type: 'adjustment', amount: 1234 })
  const over = await request('POST', path, { amount: -1235, reason: 'too much' })
  expect(over.status).toBe(409)
  expect(over.json.error).toBe('insufficient_subscription_credits')
})

it('refuses to add plan credits to a user without a plan', async () => {
  const { userId } = await fixture(false)
  const refused = await request(
    'POST',
    `/internal/admin/private/billing/users/${userId}/subscription-credits`,
    { amount: 100, reason: 'no plan' },
  )
  expect(refused.status).toBe(409)
  expect(refused.json.error).toBe('no_active_subscription')
})

it('upgrades to a higher plan immediately and carries the remaining credits over', async () => {
  const { cookie, userId, plan } = await fixture(true, '入门')
  const target = await activePlan('标准')
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(before.subscription.plan_id).toBe(plan.id)
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: target.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.status).toBe(200)
  expect(created.json.subscription_action).toBe('upgrade')
  expect(created.json.amount_cents).toBe(monthCents(target))
  const paidAt = Date.now()
  const paid = await pay(created.json)
  expect(paid.json.subscription_action).toBe('upgrade')
  const after = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(after.subscription.id).toBe(before.subscription.id)
  expect(after.subscription.plan_id).toBe(target.id)
  expect(after.subscription.plan.id).toBe(target.id)
  expect(after.subscription.scheduled_change).toBeNull()
  expect(after.subscription.starts_at).toBeGreaterThanOrEqual(paidAt)
  expect(after.subscription.ends_at).toBe(paid.json.ends_at)
  expect(after.subscription.ends_at).toBeGreaterThan(before.subscription.ends_at)
  expect(before.account.subscription_balance).toBeGreaterThan(0)
  expect(after.account.subscription_balance).toBe(
    target.monthly_credits + before.account.subscription_balance,
  )
  expect(after.account.subscription_expires_at).toBe(after.subscription.next_grant_at)
  expect(subscriptionGrants(after, target.monthly_credits)).toHaveLength(1)
})

it('keeps the current plan until the scheduled cycle, then grants the lower plan once', async () => {
  const { cookie, userId, plan: current } = await fixture(true, '专业')
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const target = await activePlan('入门')
  const other = await activePlan('标准')
  expect(current.id).toBe(before.subscription.plan_id)
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: target.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(created.status).toBe(200)
  expect(created.json.subscription_action).toBe('schedule')
  expect(created.json.amount_cents).toBe(monthCents(target))
  const paid = await pay(created.json)
  expect(paid.json.subscription_action).toBe('schedule')
  // 订单记买到的那一段：按购买月数止于旧档到期之后，而不是止于旧档到期。
  expect(paid.json.ends_at).toBeGreaterThan(before.subscription.ends_at)
  expect(await orderPeriod(created.json.id)).toEqual({
    starts_at: before.subscription.ends_at,
    ends_at: addCalendarMonths(before.subscription.ends_at, 1),
  })
  const scheduled = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(scheduled.subscription.plan_id).toBe(current.id)
  expect(scheduled.subscription.plan.id).toBe(current.id)
  expect(scheduled.subscription.ends_at).toBe(before.subscription.ends_at)
  expect(scheduled.account.subscription_balance).toBe(current.monthly_credits)
  expect(scheduled.subscription.scheduled_change).toMatchObject({
    plan_id: target.id,
    plan_name: target.name,
    period_months: 1,
    effective_at: before.subscription.ends_at,
  })
  expect(subscriptionGrants(scheduled, target.monthly_credits)).toHaveLength(0)
  const blocked = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: other.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(blocked.status).toBe(409)
  expect(blocked.json.error).toBe('scheduled_plan_change_exists')

  const realNow = Date.now
  Date.now = () => before.subscription.ends_at - 1000
  try {
    const stillCurrent = (await request('GET', `/internal/admin/private/billing/users/${userId}`))
      .json
    expect(stillCurrent.subscription.plan_id).toBe(current.id)
    expect(stillCurrent.account.subscription_balance).toBe(current.monthly_credits)
    expect(stillCurrent.subscription.scheduled_change.plan_id).toBe(target.id)
  } finally {
    Date.now = realNow
  }

  Date.now = () => before.subscription.ends_at + 1000
  try {
    const switched = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
    expect(switched.subscription.plan_id).toBe(target.id)
    expect(switched.subscription.plan.id).toBe(target.id)
    expect(switched.subscription.scheduled_change).toBeNull()
    expect(switched.account.subscription_balance).toBe(target.monthly_credits)
    expect(switched.subscription.ends_at).toBeGreaterThan(before.subscription.ends_at)
    expect(subscriptionGrants(switched, target.monthly_credits)).toHaveLength(1)
    expect(subscriptionGrants(switched, current.monthly_credits)).toHaveLength(1)
    expect(await orderPeriod(created.json.id)).toEqual({
      starts_at: switched.subscription.starts_at,
      ends_at: switched.subscription.ends_at,
    })
    expect(switched.subscription.starts_at).toBe(before.subscription.ends_at)
  } finally {
    Date.now = realNow
  }
})

it('rewrites the order period to when a moved plan change actually took effect', async () => {
  const { cookie, userId } = await fixture(true, '专业')
  const target = await activePlan('入门')
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: target.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect((await pay(created.json)).json.subscription_action).toBe('schedule')
  // 运营把当前档到期提前，换档跟着提前；生效后订单与订阅的周期必须一致。
  const movedEnd = Date.now() + 60_000
  const adjusted = await request(
    'POST',
    `/internal/admin/private/billing/subscriptions/${before.subscription.id}/expiry`,
    { ends_at: movedEnd, reason: 'switch early' },
  )
  expect(adjusted.status).toBe(200)
  const realNow = Date.now
  Date.now = () => movedEnd + 1000
  try {
    const switched = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
    expect(switched.subscription.plan_id).toBe(target.id)
    expect(switched.subscription.starts_at).toBe(movedEnd)
    const order = (
      await request('GET', `/internal/admin/private/billing/orders/${created.json.id}`)
    ).json
    expect(order.ends_at).toBe(switched.subscription.ends_at)
    expect(await orderPeriod(created.json.id)).toEqual({
      starts_at: movedEnd,
      ends_at: switched.subscription.ends_at,
    })
  } finally {
    Date.now = realNow
  }
})

it('moves a scheduled plan change to the renewed end instead of switching early', async () => {
  const { cookie, userId, plan } = await fixture(true, '专业')
  const standard = await activePlan('标准')
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const change = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: standard.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect((await pay(change.json)).status).toBe(200)
  const renewal = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(renewal.json.subscription_action).toBe('renew')
  expect((await pay(renewal.json)).status).toBe(200)
  const extended = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  expect(extended.subscription.plan_id).toBe(plan.id)
  expect(extended.subscription.ends_at).toBeGreaterThan(before.subscription.ends_at)
  expect(extended.subscription.scheduled_change.effective_at).toBe(extended.subscription.ends_at)
  expect(extended.account.subscription_balance).toBe(before.account.subscription_balance)

  const realNow = Date.now
  Date.now = () => before.subscription.ends_at + 1000
  try {
    const unchanged = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
    expect(unchanged.subscription.plan_id).toBe(plan.id)
    expect(unchanged.subscription.scheduled_change.plan_id).toBe(standard.id)
    expect(unchanged.account.subscription_balance).toBe(plan.monthly_credits)
  } finally {
    Date.now = realNow
  }

  // 换档按续费后的到期生效，订单周期跟着续费后的到期走。
  Date.now = () => extended.subscription.ends_at + 1000
  try {
    const switched = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
    expect(switched.subscription.plan_id).toBe(standard.id)
    expect(switched.subscription.starts_at).toBe(extended.subscription.ends_at)
    expect(await orderPeriod(change.json.id)).toEqual({
      starts_at: extended.subscription.ends_at,
      ends_at: addCalendarMonths(extended.subscription.ends_at, 1),
    })
    expect(switched.subscription.ends_at).toBe(addCalendarMonths(extended.subscription.ends_at, 1))
  } finally {
    Date.now = realNow
  }
})

it('rewrites the order period when the maintenance scan switches plans at the natural end', async () => {
  const { cookie, userId } = await fixture(true, '专业')
  const target = await activePlan('入门')
  const before = (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json
  const created = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: target.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect((await pay(created.json)).json.subscription_action).toBe('schedule')
  const confirmed = await orderPeriod(created.json.id)
  expect(confirmed).toEqual({
    starts_at: before.subscription.ends_at,
    ends_at: addCalendarMonths(before.subscription.ends_at, 1),
  })
  // 不改到期：时间走到原到期之后，由定时扫描（maintenance）触发换档，不经过读用户接口。
  const realNow = Date.now
  Date.now = () => before.subscription.ends_at + 1000
  try {
    const scanned = await request('POST', '/internal/admin/private/billing/maintenance')
    expect(scanned.status).toBe(200)
    expect(scanned.json.processed).toBeGreaterThanOrEqual(1)
    expect(await orderPeriod(created.json.id)).toEqual(confirmed)
    // 扫描后直接读库：读用户接口本身也会触发换档，用它断言分不清是谁换的。
    expect(await activeSubscriptionRow(userId)).toEqual({
      plan_id: target.id,
      starts_at: before.subscription.ends_at,
      ends_at: addCalendarMonths(before.subscription.ends_at, 1),
      scheduled_plan_id: null,
      scheduled_period_months: null,
      scheduled_effective_at: null,
      scheduled_order_id: null,
    })
  } finally {
    Date.now = realNow
  }
})

it('resumes the same purchase across requests but reports a different purchase explicitly', async () => {
  const { cookie, plan } = await fixture(false)
  const input = { plan_id: plan.id, period_months: 1, request_id: randomUUID() }
  const created = await request('POST', '/api/billing/orders', input, { cookie })
  expect(created.status).toBe(200)
  const resumed = await request(
    'POST',
    '/api/billing/orders',
    { ...input, request_id: randomUUID() },
    { cookie },
  )
  expect(resumed.status).toBe(200)
  expect(resumed.json.id).toBe(created.json.id)
  const conflict = await request(
    'POST',
    '/api/billing/orders',
    {
      kind: 'recharge',
      amount_cents: 5000,
      request_id: randomUUID(),
    },
    { cookie },
  )
  expect(conflict.status).toBe(409)
  expect(conflict.json.error).toBe('open_order_exists')
  expect(conflict.json.order.id).toBe(created.json.id)
  expect(conflict.json.order.kind).toBe('subscription')
  expect((await request('GET', '/api/billing/orders', undefined, { cookie })).json).toHaveLength(1)
})

it('serializes identical purchases and isolates amounts, periods and claimed orders', async () => {
  const { cookie, plan } = await fixture(false)
  const input = { kind: 'recharge', amount_cents: 5000, request_id: randomUUID() }
  const results = await Promise.all([
    request('POST', '/api/billing/orders', input, { cookie }),
    request('POST', '/api/billing/orders', { ...input, request_id: randomUUID() }, { cookie }),
  ])
  expect(results.map((r) => r.status)).toEqual([200, 200])
  expect(results[0].json.id).toBe(results[1].json.id)
  const original = results[0].json
  const different = { ...input, amount_cents: 1000, request_id: randomUUID() }
  expect((await request('POST', '/api/billing/orders', different, { cookie })).json.order.id).toBe(
    original.id,
  )
  await request('POST', `/api/billing/orders/${original.id}/cancel`, {}, { cookie })
  const replacement = await request('POST', '/api/billing/orders', different, { cookie })
  expect(replacement.json.amount_cents).toBe(1000)
  expect((await request('POST', '/api/billing/orders', different, { cookie })).json.id).toBe(
    replacement.json.id,
  )
  await request('POST', `/api/billing/orders/${replacement.json.id}/claim`, {}, { cookie })
  const blocked = await request(
    'POST',
    '/api/billing/orders',
    { plan_id: plan.id, period_months: 1, request_id: randomUUID() },
    { cookie },
  )
  expect(blocked.status).toBe(409)
  expect(blocked.json.order.status).toBe('review')
  expect(
    (await request('POST', `/api/billing/orders/${replacement.json.id}/cancel`, {}, { cookie }))
      .status,
  ).toBe(409)
  expect(
    (
      await request(
        'POST',
        '/api/billing/orders',
        { ...different, request_id: randomUUID() },
        { cookie },
      )
    ).json.status,
  ).toBe('review')
})

it('does not resume another subscription period or an expired order', async () => {
  const { cookie, plan } = await fixture(false)
  const input = { plan_id: plan.id, period_months: 1, request_id: randomUUID() }
  const order = (await request('POST', '/api/billing/orders', input, { cookie })).json
  const conflict = await request(
    'POST',
    '/api/billing/orders',
    { ...input, period_months: 3, request_id: randomUUID() },
    { cookie },
  )
  expect(conflict.status).toBe(409)
  expect(conflict.json.order.period_months).toBe(1)
  const realNow = Date.now
  Date.now = () => order.expires_at + 1000
  try {
    const fresh = await request(
      'POST',
      '/api/billing/orders',
      { ...input, request_id: randomUUID() },
      { cookie },
    )
    expect(fresh.status).toBe(200)
    expect(fresh.json.id).not.toBe(order.id)
  } finally {
    Date.now = realNow
  }
})

it('replays a resumed request after the original order becomes terminal', async () => {
  for (const terminal of ['cancelled', 'completed']) {
    const { cookie } = await fixture(false)
    const input = { kind: 'recharge', amount_cents: 5000, request_id: randomUUID() }
    const order = (await request('POST', '/api/billing/orders', input, { cookie })).json
    const resumed = { ...input, request_id: randomUUID() }
    expect((await request('POST', '/api/billing/orders', resumed, { cookie })).json.id).toBe(
      order.id,
    )
    if (terminal === 'completed') await pay(order)
    else await request('POST', `/api/billing/orders/${order.id}/cancel`, {}, { cookie })
    const replay = await request('POST', '/api/billing/orders', resumed, { cookie })
    expect(replay.status).toBe(200)
    expect(replay.json.id).toBe(order.id)
    expect(replay.json.status).toBe(terminal)
    expect((await request('POST', '/api/billing/orders', input, { cookie })).json.id).toBe(order.id)
    expect(
      (await request('POST', '/api/billing/orders', { ...resumed, amount_cents: 1000 }, { cookie }))
        .json.error,
    ).toBe('order_request_conflict')
    expect((await request('GET', '/api/billing/orders', undefined, { cookie })).json).toHaveLength(
      1,
    )
  }
})

it('confirms manually without a transaction ID or entered time and replays without duplicate credit', async () => {
  const { cookie, userId } = await fixture(false)
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      {
        kind: 'recharge',
        amount_cents: 5000,
        request_id: randomUUID(),
      },
      { cookie },
    )
  ).json
  const input = {
    channel: 'wechat',
    receiving_account: 'fixture-account',
    payment_code_id: order.payment_code.id,
    amount_cents: order.amount_cents,
    note: '',
  }
  const started = Date.now()
  const results = await Promise.all([
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, input),
    request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, input),
  ])
  expect(results.map((result) => result.status)).toEqual([200, 200])
  const detail = (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json
  expect(detail.receipt.transaction_id).toBeNull()
  expect(detail.receipt.received_at_source).toBe('confirmation')
  expect(detail.receipt.received_at).toBeGreaterThanOrEqual(started)
  expect(detail.receipt.received_at).toBeLessThanOrEqual(Date.now())
  expect(detail.completed_at).toBe(detail.receipt.received_at)
  expect(
    detail.history.filter((entry: { action: string }) => entry.action === 'confirm'),
  ).toHaveLength(1)
  expect(
    (await request('GET', `/internal/admin/private/billing/users/${userId}`)).json.payments,
  ).toHaveLength(1)
  await request('POST', `/internal/admin/private/billing/orders/${order.id}/confirm`, input)
  const replayed = (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json
  expect(replayed.receipt).toEqual(detail.receipt)
})

it('uses confirmation time for an already claimed order without treating review delay as late payment', async () => {
  const { cookie } = await fixture(false)
  const order = (
    await request(
      'POST',
      '/api/billing/orders',
      {
        kind: 'recharge',
        amount_cents: 1000,
        request_id: randomUUID(),
      },
      { cookie },
    )
  ).json
  await request('POST', `/api/billing/orders/${order.id}/claim`, {}, { cookie })
  const originalNow = Date.now
  const confirmedAt = order.expires_at + 3600000
  Date.now = () => confirmedAt
  try {
    const result = await request(
      'POST',
      `/internal/admin/private/billing/orders/${order.id}/confirm`,
      {
        channel: 'wechat',
        receiving_account: 'fixture-account',
        payment_code_id: order.payment_code.id,
        amount_cents: order.amount_cents,
        note: '',
      },
    )
    expect(result.status).toBe(200)
    const detail = (await request('GET', `/internal/admin/private/billing/orders/${order.id}`)).json
    expect(detail.receipt.received_at).toBe(confirmedAt)
    expect(detail.receipt.received_at_source).toBe('confirmation')
  } finally {
    Date.now = originalNow
  }
})
