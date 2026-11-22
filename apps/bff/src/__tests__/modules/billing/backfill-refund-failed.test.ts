import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { creditAccounts, creditLedger, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { backfillRefundFailedTasks } from '../../../modules/billing/backfill-refund-failed'

const TEST_DB = await resetTestDatabase('billing_backfill')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const handle = createDb(TEST_DB)
const { db, schema } = handle

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const MONTH_AHEAD = Date.UTC(2026, 9, 6, 12, 0, 0)
const MONTH_AGO = Date.UTC(2026, 7, 6, 12, 0, 0)

afterAll(async () => {
  await handle.close()
})

async function seedUser(id: string): Promise<void> {
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
}

async function seedAccount(input: {
  userId: string
  subscriptionBalance?: number
  rechargeBalance?: number
  subscriptionExpiresAt?: number | null
}): Promise<void> {
  await db.insert(creditAccounts).values({
    user_id: input.userId,
    subscription_balance: input.subscriptionBalance ?? 0,
    recharge_balance: input.rechargeBalance ?? 0,
    subscription_expires_at: input.subscriptionExpiresAt ?? null,
    updated_at: NOW,
  })
}

async function seedSettledTask(input: {
  taskId: string
  userId: string
  status: 'failed' | 'completed' | 'cancelled'
  holdStatus: 'committed' | 'released'
  subscriptionAmount?: number
  rechargeAmount?: number
  subscriptionExpiresAt?: number | null
  upstreamInvocationCount?: number
  errorType?: string | null
  upstreamStatus?: number | null
}): Promise<void> {
  const subscriptionAmount = input.subscriptionAmount ?? 0
  const rechargeAmount = input.rechargeAmount ?? 0
  await db.insert(schema.tasks).values({
    id: input.taskId,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: input.status,
    request_payload: { prompt: 'backfill fixture', device_id: 'backfill-device' },
    submitted_at: NOW,
    completed_at: NOW,
    user_id: input.userId,
    upstream_invocation_count: input.upstreamInvocationCount ?? 1,
    error_type: input.errorType ?? null,
    upstream_status: input.upstreamStatus ?? null,
  })
  await db.insert(taskHolds).values({
    task_id: input.taskId,
    user_id: input.userId,
    subscription_amount: subscriptionAmount,
    recharge_amount: rechargeAmount,
    subscription_expires_at: input.subscriptionExpiresAt ?? null,
    total_amount: subscriptionAmount + rechargeAmount,
    model: 'gpt-image-2',
    quantity: 1,
    status: input.holdStatus,
    created_at: NOW,
    settled_at: NOW,
  })
}

beforeEach(async () => {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
})

describe('failed task refund backfill', () => {
  it('refunds a committed hold on a failed task exactly once', async () => {
    await seedUser('user-recharge')
    await seedAccount({ userId: 'user-recharge', rechargeBalance: 500 })
    await seedSettledTask({
      taskId: 'task-failed',
      userId: 'user-recharge',
      status: 'failed',
      holdStatus: 'committed',
      rechargeAmount: 100,
      upstreamInvocationCount: 2,
      errorType: 'upstream_error',
      upstreamStatus: 503,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW })

    expect(report).toMatchObject({
      dryRun: false,
      refundedTasks: 1,
      refundedSubscription: 0,
      refundedRecharge: 100,
      expiredSubscription: 0,
    })
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-recharge'))
    expect(account?.recharge_balance).toBe(600)
    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, 'task-failed'))
    expect(hold?.status).toBe('released')
    const entries = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.task_id, 'task-failed'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      bucket: 'recharge',
      entry_type: 'release',
      amount: 100,
      note: 'backfill: failed task refund',
      metadata: {
        upstream_invocation_count: 2,
        error_type: 'upstream_error',
        upstream_status: 503,
        backfill: true,
      },
    })

    const second = await backfillRefundFailedTasks({ db, now: NOW })
    expect(second.refundedTasks).toBe(0)
    const [afterSecond] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-recharge'))
    expect(afterSecond?.recharge_balance).toBe(600)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.task_id, 'task-failed')),
    ).toHaveLength(1)
  })

  it('leaves completed and already released holds alone', async () => {
    await seedUser('user-untouched')
    await seedAccount({ userId: 'user-untouched', rechargeBalance: 500 })
    await seedSettledTask({
      taskId: 'task-completed',
      userId: 'user-untouched',
      status: 'completed',
      holdStatus: 'committed',
      rechargeAmount: 100,
    })
    await seedSettledTask({
      taskId: 'task-already-released',
      userId: 'user-untouched',
      status: 'failed',
      holdStatus: 'released',
      rechargeAmount: 100,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW })

    expect(report.refundedTasks).toBe(0)
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-untouched'))
    expect(account?.recharge_balance).toBe(500)
    expect(await db.select().from(creditLedger)).toHaveLength(0)
  })

  it('keeps an expired subscription share out of the account and says so', async () => {
    await seedUser('user-expired')
    await seedAccount({
      userId: 'user-expired',
      subscriptionBalance: 1_000,
      rechargeBalance: 500,
      subscriptionExpiresAt: MONTH_AHEAD,
    })
    await seedSettledTask({
      taskId: 'task-expired-plan',
      userId: 'user-expired',
      status: 'failed',
      holdStatus: 'committed',
      subscriptionAmount: 300,
      rechargeAmount: 50,
      subscriptionExpiresAt: MONTH_AGO,
      errorType: 'upstream_error',
      upstreamStatus: 403,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW })

    expect(report).toMatchObject({
      refundedTasks: 1,
      refundedSubscription: 0,
      refundedRecharge: 50,
      expiredSubscription: 300,
    })
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-expired'))
    expect(account).toMatchObject({ subscription_balance: 1_000, recharge_balance: 550 })
    const entries = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.task_id, 'task-expired-plan'))
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual(
      expect.objectContaining({
        bucket: 'subscription',
        entry_type: 'release',
        amount: 0,
        note: 'backfill: failed task refund（300 套餐积分已过期，未退回）',
        metadata: expect.objectContaining({ expired_amount: 300, backfill: true }),
      }),
    )
  })

  it('returns a live subscription share to the subscription bucket', async () => {
    await seedUser('user-live-plan')
    await seedAccount({
      userId: 'user-live-plan',
      subscriptionBalance: 1_000,
      subscriptionExpiresAt: MONTH_AHEAD,
    })
    await seedSettledTask({
      taskId: 'task-live-plan',
      userId: 'user-live-plan',
      status: 'failed',
      holdStatus: 'committed',
      subscriptionAmount: 300,
      subscriptionExpiresAt: MONTH_AHEAD,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW })

    expect(report).toMatchObject({ refundedSubscription: 300, expiredSubscription: 0 })
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-live-plan'))
    expect(account?.subscription_balance).toBe(1_300)
  })

  it('counts a hold whose credit account is gone instead of reporting a refund', async () => {
    await seedUser('user-gone')
    await seedSettledTask({
      taskId: 'task-no-account',
      userId: 'user-gone',
      status: 'failed',
      holdStatus: 'committed',
      rechargeAmount: 100,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW })

    expect(report).toMatchObject({ refundedTasks: 0, skippedTasks: 1 })
    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, 'task-no-account'))
    expect(hold?.status).toBe('committed')
    expect(await db.select().from(creditLedger)).toHaveLength(0)
  })

  it('changes nothing in a dry run but reports the whole plan', async () => {
    await seedUser('user-dry')
    await seedAccount({ userId: 'user-dry', rechargeBalance: 500 })
    await seedSettledTask({
      taskId: 'task-dry',
      userId: 'user-dry',
      status: 'failed',
      holdStatus: 'committed',
      rechargeAmount: 100,
    })

    const report = await backfillRefundFailedTasks({ db, now: NOW, dryRun: true })

    expect(report).toMatchObject({ dryRun: true, refundedTasks: 1, refundedRecharge: 100 })
    expect(report.rows[0]).toMatchObject({
      taskId: 'task-dry',
      userId: 'user-dry',
      subscriptionRefund: 0,
      rechargeRefund: 100,
    })
    const [account] = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.user_id, 'user-dry'))
    expect(account?.recharge_balance).toBe(500)
    const [hold] = await db.select().from(taskHolds).where(eq(taskHolds.task_id, 'task-dry'))
    expect(hold?.status).toBe('committed')
    expect(await db.select().from(creditLedger)).toHaveLength(0)
  })
})
