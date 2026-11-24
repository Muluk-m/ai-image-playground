import { randomUUID } from 'node:crypto'
import {
  accountFacts,
  creditAccounts,
  creditLedger,
  modelPrices,
  taskHolds,
  unmeteredEntitlements,
} from '@image-playground/db/billing'
import { type ConfirmedPaymentInput, MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import type {
  BffTransaction,
  PrivateTaskHooks,
  TaskReservationResult,
  TaskUsage,
} from '../../lib/billing-hooks'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { ensureAccount, lockAccount } from './accounts'
import { allocateCredits, creditsFor } from './calculations'
import { feishuWithoutCreditAccount, reconcileAccount, unmeteredEntitlement } from './entitlement'
import { beginConfirmedPayment } from './payments'
import { modelAvailabilityActive } from './pricing'
import { applyRegistrationReferral } from './referrals'
import { ledgerRow, partialRefund, refundableSubscriptionAmount, settledAmount } from './settlement'

const OPERATOR_ID = 'admin'
const DEFAULT_UNMETERED_DAILY_QUOTA = 20
const DEFAULT_UNMETERED_GUARANTEED_CONCURRENCY = 2
const DEFAULT_UNMETERED_IDLE_CONCURRENCY = 0

export async function reserveTask(
  input: Parameters<PrivateTaskHooks['reserveTask']>[0],
): Promise<TaskReservationResult> {
  if (!isCapabilityEnabled('billing:credits')) return { kind: 'reserved', credits: 0 }
  if (await feishuWithoutCreditAccount(input.tx, input.userId)) {
    return { kind: 'access_denied', reason: 'billing_account_unavailable' }
  }
  const now = Date.now()
  const { account } = await reconcileAccount(input.tx, input.userId, now)
  const [price] = await input.tx
    .select()
    .from(modelPrices)
    .where(eq(modelPrices.model, input.model))
    .limit(1)
  if (!price || !(await modelAvailabilityActive(input.tx, input.model)))
    return { kind: 'price_unavailable', model: input.model }

  const required = creditsFor({
    creditsPerUnit: price.credits_per_image,
    quantity: input.quantity,
    unitMultiplier: input.unitMultiplier,
  })
  const allocation = allocateCredits(
    required,
    account.subscription_balance,
    account.recharge_balance,
  )
  if (!allocation.ok) return { kind: 'insufficient_credits', ...allocation }

  await input.tx
    .update(creditAccounts)
    .set({
      subscription_balance: account.subscription_balance - allocation.subscription,
      recharge_balance: account.recharge_balance - allocation.recharge,
      updated_at: now,
    })
    .where(eq(creditAccounts.user_id, input.userId))
  await input.tx.insert(taskHolds).values({
    task_id: input.taskId,
    user_id: input.userId,
    subscription_amount: allocation.subscription,
    recharge_amount: allocation.recharge,
    subscription_expires_at: allocation.subscription > 0 ? account.subscription_expires_at : null,
    total_amount: required,
    credits_per_unit: price.credits_per_image,
    model: input.model,
    quantity: input.quantity,
    status: 'held',
    created_at: now,
  })
  const entries = (
    [
      ['subscription', allocation.subscription],
      ['recharge', allocation.recharge],
    ] as const
  )
    .filter(([, amount]) => amount > 0)
    .map(([bucket, amount]) =>
      ledgerRow({
        userId: input.userId,
        bucket,
        type: 'hold',
        amount: -amount,
        now,
        taskId: input.taskId,
        model: input.model,
        quantity: input.quantity,
        metadata: { unit: price.unit, unit_multiplier: input.unitMultiplier },
      }),
    )
  if (entries.length) await input.tx.insert(creditLedger).values(entries)
  return { kind: 'reserved', credits: required }
}

function settledOf(
  hold: typeof taskHolds.$inferSelect,
  actualUsage: TaskUsage | undefined,
): number {
  if (!actualUsage || hold.credits_per_unit === null) return hold.total_amount
  return settledAmount({
    creditsPerUnit: hold.credits_per_unit,
    quantity: actualUsage.quantity,
    unitMultiplier: actualUsage.unitMultiplier,
    reservedAmount: hold.total_amount,
  })
}

async function hasBillingTaskHoldsTable(tx: BffTransaction): Promise<boolean> {
  const [row] = await tx.execute(
    sql`SELECT to_regclass('billing_task_holds') IS NOT NULL AS exists`,
  )
  return Boolean((row as { exists?: boolean } | undefined)?.exists)
}

export async function finalizeTask(
  input: Parameters<PrivateTaskHooks['finalizeTask']>[0],
): Promise<void> {
  // 即使运营临时关闭 billing:credits，也要把此前预扣中的在途单结清；但从未跑过计费迁移的自托管库没有表，不能让外层事务报 42P01。
  if (!isCapabilityEnabled('billing:credits') && !(await hasBillingTaskHoldsTable(input.tx))) return
  const [hold] = await input.tx
    .select()
    .from(taskHolds)
    .where(eq(taskHolds.task_id, input.taskId))
    .for('update')
    .limit(1)
  if (!hold || hold.status !== 'held') return

  const now = Date.now()
  // 只有交付了图片才收钱：上游被调用过但任务失败，用户什么也没拿到，一律退回。
  const committed = input.outcome === 'completed'
  const refund = partialRefund({
    settled: committed ? settledOf(hold, input.actualUsage) : 0,
    subscriptionHeld: hold.subscription_amount,
    rechargeHeld: hold.recharge_amount,
  })
  let subscriptionRelease = 0
  const rechargeRelease = refund.rechargeRefund
  if (refund.subscriptionRefund > 0) {
    const account = await lockAccount(input.tx, hold.user_id)
    subscriptionRelease = refundableSubscriptionAmount({
      subscriptionAmount: refund.subscriptionRefund,
      holdExpiresAt: hold.subscription_expires_at,
      accountExpiresAt: account.subscription_expires_at,
      now,
    })
  }
  if (subscriptionRelease > 0 || rechargeRelease > 0) {
    await input.tx
      .update(creditAccounts)
      .set({
        subscription_balance: sql`${creditAccounts.subscription_balance} + ${subscriptionRelease}`,
        recharge_balance: sql`${creditAccounts.recharge_balance} + ${rechargeRelease}`,
        updated_at: now,
      })
      .where(eq(creditAccounts.user_id, hold.user_id))
  }
  await input.tx
    .update(taskHolds)
    .set({
      status: committed ? 'committed' : 'released',
      settled_at: now,
      // 退不回去的过期套餐积分照样是用户花掉的，所以减的是真退回额，不是应退额。
      net_spend: hold.total_amount - subscriptionRelease - rechargeRelease,
      ...(input.actualUsage?.tokens
        ? {
            input_tokens: input.actualUsage.tokens.input,
            cached_input_tokens: input.actualUsage.tokens.cachedInput ?? 0,
            output_tokens: input.actualUsage.tokens.output,
          }
        : {}),
    })
    .where(eq(taskHolds.task_id, input.taskId))

  const failureSummary = {
    ...(input.errorType ? { error_type: input.errorType } : {}),
    ...(typeof input.upstreamStatus === 'number' ? { upstream_status: input.upstreamStatus } : {}),
  }
  const common = {
    userId: hold.user_id,
    now,
    taskId: hold.task_id,
    model: hold.model,
    quantity: hold.quantity,
  }
  const buckets = [
    {
      bucket: 'subscription' as const,
      held: hold.subscription_amount,
      refunded: refund.subscriptionRefund,
      released: subscriptionRelease,
    },
    {
      bucket: 'recharge' as const,
      held: hold.recharge_amount,
      refunded: refund.rechargeRefund,
      released: rechargeRelease,
    },
  ].filter((entry) => entry.held > 0)

  const entries = [
    ...(committed
      ? buckets.map(({ bucket }) =>
          ledgerRow({
            ...common,
            bucket,
            type: 'commit',
            amount: 0,
            metadata: {
              upstream_invocation_count: input.upstreamInvocationCount,
              ...(input.actualUsage
                ? {
                    unit_multiplier: input.actualUsage.unitMultiplier,
                    tokens: input.actualUsage.tokens,
                  }
                : {}),
            },
          }),
        )
      : []),
    ...buckets
      .filter(({ refunded }) => refunded > 0)
      .map(({ bucket, refunded, released }) => {
        const expiredAmount = refunded - released
        return ledgerRow({
          ...common,
          bucket,
          type: 'release',
          amount: released,
          note: expiredAmount > 0 ? `${expiredAmount} 套餐积分已过期，未退回` : undefined,
          metadata: {
            upstream_invocation_count: input.upstreamInvocationCount,
            ...(committed ? {} : failureSummary),
            ...(expiredAmount > 0 ? { expired_amount: expiredAmount } : {}),
          },
        })
      }),
  ]
  if (entries.length) await input.tx.insert(creditLedger).values(entries)
}

/** 账没结完的任务不出现在结果里：报 0 会被读成「这一笔免费」。 */
export async function taskCredits(input: {
  taskIds: readonly string[]
}): Promise<Readonly<Record<string, number>>> {
  if (!isCapabilityEnabled('billing:credits') || input.taskIds.length === 0) return {}
  const rows = await db
    .select({ taskId: taskHolds.task_id, netSpend: taskHolds.net_spend })
    .from(taskHolds)
    .where(inArray(taskHolds.task_id, [...input.taskIds]))
  const credits: Record<string, number> = {}
  for (const row of rows) {
    if (row.netSpend !== null) credits[row.taskId] = row.netSpend
  }
  return credits
}

export async function onUserCreated(
  input: Parameters<PrivateTaskHooks['onUserCreated']>[0],
): Promise<void> {
  if (!isCapabilityEnabled('billing:credits')) return
  const now = Date.now()
  if (input.oauthProvider === 'feishu') {
    await input.tx
      .insert(accountFacts)
      .values({ user_id: input.userId, category: 'feishu_unmetered', created_at: now })
      .onConflictDoNothing()
    await input.tx
      .insert(unmeteredEntitlements)
      .values({
        user_id: input.userId,
        daily_quota: DEFAULT_UNMETERED_DAILY_QUOTA,
        guaranteed_concurrency: DEFAULT_UNMETERED_GUARANTEED_CONCURRENCY,
        idle_concurrency: DEFAULT_UNMETERED_IDLE_CONCURRENCY,
        enabled: true,
        updated_at: now,
      })
      .onConflictDoNothing()
    return
  }
  await ensureAccount(input.tx, input.userId, now)
  await applyRegistrationReferral(input, now)
}

export interface RechargeAdjustment {
  userId: string
  amount: number
  reason: string
  payment: ConfirmedPaymentInput | null
  operatorId?: string
}

export async function adjustRechargeCredits(input: RechargeAdjustment) {
  return db.transaction((tx) => adjustRechargeCreditsInTransaction(tx, input))
}

export async function adjustRechargeCreditsInTransaction(
  tx: BffTransaction,
  input: RechargeAdjustment,
) {
  if (
    !Number.isInteger(input.amount) ||
    input.amount === 0 ||
    Math.abs(input.amount) > MAX_CREDIT_BALANCE
  ) {
    throw new Error('invalid_amount')
  }
  const reason = input.reason.trim()
  if (!reason) throw new Error('reason_required')
  if (await unmeteredEntitlement(tx, input.userId)) throw new Error('billing_account_unavailable')
  if (input.payment !== null && input.amount <= 0) throw new Error('invalid_payment')
  const now = Date.now()
  const payment = await beginConfirmedPayment(tx, {
    userId: input.userId,
    kind: 'recharge',
    payment: input.payment,
    details: { amount: input.amount, reason },
    operatorId: input.operatorId ?? OPERATOR_ID,
    now,
  })
  if (payment?.replay) return reconcileAccount(tx, input.userId, now)
  const { account } = await reconcileAccount(tx, input.userId, now)
  // reconcileAccount holds the same row lock used by task reservations.
  const balance = account.recharge_balance + input.amount
  if (balance < 0) throw new Error('insufficient_recharge_credits')
  if (balance > MAX_CREDIT_BALANCE) throw new Error('credit_balance_overflow')
  await tx
    .update(creditAccounts)
    .set({
      recharge_balance: balance,
      updated_at: now,
    })
    .where(eq(creditAccounts.user_id, input.userId))
  await tx.insert(creditLedger).values(
    ledgerRow({
      userId: input.userId,
      bucket: 'recharge',
      type: payment ? 'recharge' : 'adjustment',
      amount: input.amount,
      now,
      operatorId: input.operatorId ?? OPERATOR_ID,
      note: reason,
      referenceId: payment?.record.id,
    }),
  )
  await tx.insert(publicSchema.operator_audits).values({
    id: randomUUID(),
    operator_id: input.operatorId ?? OPERATOR_ID,
    action: payment ? 'billing.payment.confirm' : 'billing.credits.adjust',
    target_type: 'user',
    target_id: input.userId,
    details: { amount: input.amount, reason, payment_id: payment?.record.id ?? null },
    created_at: now,
  })
  return reconcileAccount(tx, input.userId, now)
}
