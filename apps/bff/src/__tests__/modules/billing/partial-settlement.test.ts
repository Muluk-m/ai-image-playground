import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { creditAccounts, creditLedger, modelPrices, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('billing_partial_settlement')
const WELCOME = 2_000
const CHAT_MODEL = 'chat-turn'
const CREDITS_PER_UNIT = 6
const DAY_MS = 86_400_000

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-partial'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
process.env.WELCOME_CREDITS = String(WELCOME)
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { close: closeDb, db, schema } = await import('../../../db/client')
const { getAccountSnapshot, getSpendActivity, privateTaskHooks, reconcileAccount } = await import(
  '../../../modules/billing/service'
)

type LedgerShape = { bucket: string; entry_type: string; amount: number }

const USER_ID = 'partial-settlement-user'

async function seedUser(): Promise<void> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: `partial-${randomUUID()}`,
    password_hash: 'fixture',
    created_at: now,
    updated_at: now,
  })
}

async function seedTask(taskId: string): Promise<void> {
  await db.insert(schema.tasks).values({
    id: taskId,
    provider: 'openai-compat',
    model: CHAT_MODEL,
    status: 'completed',
    request_payload: { prompt: 'partial settlement fixture', device_id: 'partial-device' },
    submitted_at: Date.now(),
    upstream_invocation_count: 1,
  })
}

async function reserve(taskId: string, unitMultiplier: number) {
  await seedTask(taskId)
  const result = await db.transaction((tx) =>
    privateTaskHooks.reserveTask({
      tx,
      taskId,
      userId: USER_ID,
      model: CHAT_MODEL,
      quantity: 1,
      unitMultiplier,
    }),
  )
  expect(result).toMatchObject({ kind: 'reserved' })
  return result
}

async function finalize(
  taskId: string,
  options: {
    outcome?: 'completed' | 'failed'
    actualUsage?: { quantity: number; unitMultiplier: number }
  } = {},
): Promise<void> {
  await db.transaction((tx) =>
    privateTaskHooks.finalizeTask({
      tx,
      taskId,
      outcome: options.outcome ?? 'completed',
      upstreamInvocationCount: 1,
      ...(options.actualUsage ? { actualUsage: options.actualUsage } : {}),
    }),
  )
}

async function balances(): Promise<{ subscription: number; recharge: number }> {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.user_id, USER_ID))
  if (!account) throw new Error('billing account missing')
  return { subscription: account.subscription_balance, recharge: account.recharge_balance }
}

async function ledgerOf(taskId: string): Promise<LedgerShape[]> {
  const rows = await db
    .select({
      bucket: creditLedger.bucket,
      entry_type: creditLedger.entry_type,
      amount: creditLedger.amount,
    })
    .from(creditLedger)
    .where(eq(creditLedger.task_id, taskId))
  return rows.sort(
    (left, right) =>
      left.entry_type.localeCompare(right.entry_type) || left.bucket.localeCompare(right.bucket),
  )
}

async function grantSubscriptionBucket(amount: number): Promise<void> {
  await db.transaction((tx) => reconcileAccount(tx, USER_ID))
  await db
    .update(creditAccounts)
    .set({
      subscription_balance: amount,
      subscription_expires_at: Date.now() + 30 * DAY_MS,
      updated_at: Date.now(),
    })
    .where(eq(creditAccounts.user_id, USER_ID))
}

async function priceChatModel(creditsPerUnit: number): Promise<void> {
  await db
    .insert(modelPrices)
    .values({ model: CHAT_MODEL, credits_per_image: creditsPerUnit, active: true, updated_at: 0 })
    .onConflictDoUpdate({
      target: modelPrices.model,
      set: { credits_per_image: creditsPerUnit, active: true },
    })
}

beforeEach(async () => {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  await seedUser()
  await priceChatModel(CREDITS_PER_UNIT)
})

afterAll(async () => {
  await db.delete(modelPrices).where(eq(modelPrices.model, CHAT_MODEL))
  await closeDb()
})

describe('settling a reservation against the usage the upstream reported', () => {
  it('charges the actual usage and returns the difference to the bucket it came from', async () => {
    await reserve('partial-under', 20)
    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 120 })

    await finalize('partial-under', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 42 })
    expect(await ledgerOf('partial-under')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
      { bucket: 'recharge', entry_type: 'release', amount: 78 },
    ])
    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, 'partial-under'))
    expect(hold?.status).toBe('committed')
    const snapshot = await getAccountSnapshot(USER_ID)
    const taskLedger = snapshot.ledger.filter((entry) => entry.task_id === 'partial-under')
    expect(taskLedger).toHaveLength(3)
    expect(taskLedger.every((entry) => entry.task_net_spend === 42)).toBeTrue()
    expect(taskLedger.every((entry) => entry.task_hold_status === 'committed')).toBeTrue()
    const release = taskLedger.find((entry) => entry.entry_type === 'release')
    expect(release?.task_settled_at).toBe(release?.created_at)
  })

  it('splits the difference back across both buckets the reservation drew from', async () => {
    await grantSubscriptionBucket(100)
    await reserve('partial-cross-bucket', 20)
    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 20 })

    await finalize('partial-cross-bucket', { actualUsage: { quantity: 1, unitMultiplier: 5 } })

    expect(await balances()).toEqual({ subscription: 70, recharge: WELCOME })
    expect(await ledgerOf('partial-cross-bucket')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'subscription', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -20 },
      { bucket: 'subscription', entry_type: 'hold', amount: -100 },
      { bucket: 'recharge', entry_type: 'release', amount: 20 },
      { bucket: 'subscription', entry_type: 'release', amount: 70 },
    ])
  })

  it('charges no more than the reservation when the reported usage runs over it', async () => {
    await reserve('partial-over', 20)

    await finalize('partial-over', { actualUsage: { quantity: 1, unitMultiplier: 400 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 120 })
    expect(await ledgerOf('partial-over')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
    ])
  })

  it('returns the whole reservation when the reported usage is zero', async () => {
    await reserve('partial-zero', 20)

    await finalize('partial-zero', { actualUsage: { quantity: 1, unitMultiplier: 0 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME })
    expect(await ledgerOf('partial-zero')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
      { bucket: 'recharge', entry_type: 'release', amount: 120 },
    ])
  })

  it('writes nothing more when the same task settles twice', async () => {
    await reserve('partial-idempotent', 20)

    await finalize('partial-idempotent', { actualUsage: { quantity: 1, unitMultiplier: 7 } })
    await finalize('partial-idempotent', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 42 })
    expect(await ledgerOf('partial-idempotent')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
      { bucket: 'recharge', entry_type: 'release', amount: 78 },
    ])
  })

  it('returns the whole reservation when a metered task fails', async () => {
    await reserve('partial-failed', 20)

    await finalize('partial-failed', {
      outcome: 'failed',
      actualUsage: { quantity: 1, unitMultiplier: 7 },
    })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME })
    expect(await ledgerOf('partial-failed')).toEqual([
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
      { bucket: 'recharge', entry_type: 'release', amount: 120 },
    ])
  })

  it('commits the whole reservation when no usage is reported', async () => {
    await reserve('partial-unmetered', 20)

    await finalize('partial-unmetered')

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 120 })
    expect(await ledgerOf('partial-unmetered')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
    ])
  })

  it('commits the whole reservation when the hold predates the recorded unit price', async () => {
    await reserve('partial-legacy', 20)
    await db
      .update(taskHolds)
      .set({ credits_per_unit: null })
      .where(eq(taskHolds.task_id, 'partial-legacy'))

    await finalize('partial-legacy', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 120 })
    expect(await ledgerOf('partial-legacy')).toEqual([
      { bucket: 'recharge', entry_type: 'commit', amount: 0 },
      { bucket: 'recharge', entry_type: 'hold', amount: -120 },
    ])
  })

  it('settles on the price recorded at reservation time, not the price today', async () => {
    await reserve('partial-reprice', 20)
    await priceChatModel(CREDITS_PER_UNIT * 10)

    await finalize('partial-reprice', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    expect(await balances()).toEqual({ subscription: 0, recharge: WELCOME - 42 })
  })

  it('counts the settled amount and not the reservation as spend', async () => {
    await reserve('partial-spend', 20)
    await finalize('partial-spend', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    const activity = await getSpendActivity({ userId: USER_ID })
    expect(activity.days.map((day) => day.count)).toEqual([42])
  })
})

describe('回报给公开树的积分数', () => {
  it('预扣时把占住的积分交出去', async () => {
    expect(await reserve('credits-reserved', 20)).toEqual({ kind: 'reserved', credits: 120 })
  })

  it('结算后按净消耗回报，不回报预扣额', async () => {
    await reserve('credits-partial', 20)
    await finalize('credits-partial', { actualUsage: { quantity: 1, unitMultiplier: 7 } })

    expect(await privateTaskHooks.taskCredits({ taskIds: ['credits-partial'] })).toEqual({
      'credits-partial': 42,
    })
  })

  it('全额退回的任务回报 0', async () => {
    await reserve('credits-refunded', 20)
    await finalize('credits-refunded', { outcome: 'failed' })

    expect(await privateTaskHooks.taskCredits({ taskIds: ['credits-refunded'] })).toEqual({
      'credits-refunded': 0,
    })
  })

  it('退不回去的过期套餐积分仍然算这一笔的消耗', async () => {
    await grantSubscriptionBucket(100)
    await reserve('credits-expired', 10)
    // 套餐期在结算前翻篇：应退的 60 退不回去，用户确实少了这些积分。
    await db
      .update(creditAccounts)
      .set({ subscription_expires_at: Date.now() - DAY_MS })
      .where(eq(creditAccounts.user_id, USER_ID))

    await finalize('credits-expired', { outcome: 'failed' })

    expect(await privateTaskHooks.taskCredits({ taskIds: ['credits-expired'] })).toEqual({
      'credits-expired': 60,
    })
  })

  it('账没结完的任务不出现在结果里', async () => {
    await reserve('credits-held', 20)

    expect(await privateTaskHooks.taskCredits({ taskIds: ['credits-held'] })).toEqual({})
  })

  it('一轮的几条任务一次问完，没有占用记录的不出现', async () => {
    await reserve('credits-chat', 10)
    await finalize('credits-chat', { actualUsage: { quantity: 1, unitMultiplier: 7 } })
    await reserve('credits-image', 5)
    await finalize('credits-image')

    expect(
      await privateTaskHooks.taskCredits({
        taskIds: ['credits-chat', 'credits-image', 'credits-never-billed'],
      }),
    ).toEqual({ 'credits-chat': 42, 'credits-image': 30 })
  })

  it('没有任务 id 就不查库', async () => {
    expect(await privateTaskHooks.taskCredits({ taskIds: [] })).toEqual({})
  })
})
