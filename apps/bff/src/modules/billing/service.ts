import { createHash, randomUUID } from 'node:crypto'
import {
  accountFacts,
  billingSettings,
  confirmedPayments,
  creditAccounts,
  creditLedger,
  type ModelPriceUnit,
  modelPrices,
  planPrices,
  plans,
  purchaseOrders,
  referralRelationships,
  subscriptions,
  taskHolds,
  unmeteredEntitlements,
  unmeteredQuota,
} from '@image-playground/db/billing'
import {
  type ConfirmedPaymentInput,
  MAX_CREDIT_BALANCE,
  type ScheduledPlanChange,
} from '@image-playground/shared'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { config } from '../../config'
import { db, schema as publicSchema } from '../../db/client'
import type {
  BffTransaction,
  PrivateTaskHooks,
  TaskReservationResult,
  TaskUsage,
} from '../../lib/billing-hooks'
import { nonBillingPriceSnapshot } from '../../lib/billing-hooks'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { getChannels } from '../../lib/channels'
import { reservedTokenUsage } from '../../lib/token-pricing'
import { ensureAccount, lockAccount } from './accounts'
import {
  addCalendarMonths,
  allocateCredits,
  ceilCredits,
  creditsFor,
  dayInTimezone,
  effectivePrice,
  nextMonthlyOccurrence,
  resolveActivityRange,
} from './calculations'
import { deploymentTimezone, rechargeAmountsYuan, rechargeCreditsPerYuan } from './config'
import { notifyNewOrders } from './order-notifications'
import { beginConfirmedPayment } from './payments'
import { applyRegistrationReferral, getReferralPolicy } from './referrals'
import { ledgerRow, partialRefund, refundableSubscriptionAmount, settledAmount } from './settlement'

const OPERATOR_ID = 'admin'
const DEFAULT_UNMETERED_DAILY_QUOTA = 20
const DEFAULT_UNMETERED_GUARANTEED_CONCURRENCY = 2
const DEFAULT_UNMETERED_IDLE_CONCURRENCY = 0

type Transaction = BffTransaction
export async function unmeteredEntitlement(tx: Transaction, userId: string) {
  const [fact] = await tx
    .select({ userId: accountFacts.user_id })
    .from(accountFacts)
    .where(eq(accountFacts.user_id, userId))
    .limit(1)
  if (!fact) return null
  const [entitlement] = await tx
    .select()
    .from(unmeteredEntitlements)
    .where(eq(unmeteredEntitlements.user_id, userId))
    .limit(1)
  if (!entitlement) return null
  if (
    !entitlement.enabled ||
    !Number.isSafeInteger(entitlement.daily_quota) ||
    entitlement.daily_quota <= 0 ||
    !Number.isSafeInteger(entitlement.guaranteed_concurrency) ||
    entitlement.guaranteed_concurrency <= 0 ||
    !Number.isSafeInteger(entitlement.idle_concurrency) ||
    entitlement.idle_concurrency < 0
  )
    return null
  return entitlement
}
async function feishuWithoutCreditAccount(tx: Transaction, userId: string): Promise<boolean> {
  const [fact] = await tx
    .select({ userId: accountFacts.user_id })
    .from(accountFacts)
    .where(eq(accountFacts.user_id, userId))
    .limit(1)
  if (!fact) return false
  const [account] = await tx
    .select({ user_id: creditAccounts.user_id })
    .from(creditAccounts)
    .where(eq(creditAccounts.user_id, userId))
    .limit(1)
  return !account
}

export function unmeteredQuotaUnits(input: { quantity: number; unitMultiplier: number }): number {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return 0
  if (!Number.isFinite(input.unitMultiplier) || input.unitMultiplier <= 0) return 0
  return Math.max(1, ceilCredits(input.quantity * input.unitMultiplier))
}

async function modelAvailabilityActive(tx: Transaction, model: string): Promise<boolean> {
  const [availability] = await tx
    .select({ active: publicSchema.model_availability.active })
    .from(publicSchema.model_availability)
    .where(eq(publicSchema.model_availability.model, model))
    .limit(1)
  return availability?.active ?? true
}

function quotaResetAt(now: number): string {
  const next = new Date(now)
  next.setUTCHours(0, 0, 0, 0)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}

async function consumeUnmeteredQuota(
  input: Parameters<NonNullable<PrivateTaskHooks['consumeUnmeteredQuota']>>[0],
) {
  if (!isCapabilityEnabled('billing:credits')) return { kind: 'consumed' as const }
  const entitlement = await unmeteredEntitlement(input.tx, input.userId)
  if (!entitlement)
    return { kind: 'quota_exceeded' as const, quota: 0, used: 0, resetAt: quotaResetAt(Date.now()) }
  const units = unmeteredQuotaUnits(input)
  const date = new Date().toISOString().slice(0, 10)
  const rows =
    units > 0 && units <= entitlement.daily_quota
      ? await input.tx
          .insert(unmeteredQuota)
          .values({ user_id: input.userId, date, units })
          .onConflictDoUpdate({
            target: [unmeteredQuota.user_id, unmeteredQuota.date],
            set: { units: sql`${unmeteredQuota.units} + ${units}` },
            setWhere: sql`${unmeteredQuota.units} + ${units} <= ${entitlement.daily_quota}`,
          })
          .returning({ units: unmeteredQuota.units })
      : []
  if (rows.length > 0) return { kind: 'consumed' as const }
  const [current] = await input.tx
    .select({ units: unmeteredQuota.units })
    .from(unmeteredQuota)
    .where(and(eq(unmeteredQuota.user_id, input.userId), eq(unmeteredQuota.date, date)))
    .limit(1)
  return {
    kind: 'quota_exceeded' as const,
    quota: entitlement.daily_quota,
    used: current?.units ?? 0,
    resetAt: quotaResetAt(Date.now()),
  }
}

async function expireSubscriptionBalance(
  tx: Transaction,
  account: typeof creditAccounts.$inferSelect,
  now: number,
  referenceId: string,
): Promise<typeof creditAccounts.$inferSelect> {
  if (account.subscription_balance > 0) {
    await tx.insert(creditLedger).values(
      ledgerRow({
        userId: account.user_id,
        bucket: 'subscription',
        type: 'expire',
        amount: -account.subscription_balance,
        now,
        referenceId,
        note: '订阅积分到期清零',
      }),
    )
  }
  const next = {
    ...account,
    subscription_balance: 0,
    subscription_expires_at: null,
    updated_at: now,
  }
  await tx
    .update(creditAccounts)
    .set({ subscription_balance: 0, subscription_expires_at: null, updated_at: now })
    .where(eq(creditAccounts.user_id, account.user_id))
  return next
}

async function grantMonthlyCredits(
  tx: Transaction,
  account: typeof creditAccounts.$inferSelect,
  monthlyCredits: number,
  grantAt: number,
  subscriptionId: string,
  now: number,
  /** 升档时并入的旧档剩余订阅积分，随新档这一期一起到期。 */
  carryOver = 0,
): Promise<typeof creditAccounts.$inferSelect> {
  const expiresAt = addCalendarMonths(grantAt, 1)
  await tx
    .update(creditAccounts)
    .set({
      subscription_balance: monthlyCredits + carryOver,
      subscription_expires_at: expiresAt,
      updated_at: now,
    })
    .where(eq(creditAccounts.user_id, account.user_id))
  await tx.insert(creditLedger).values(
    ledgerRow({
      userId: account.user_id,
      bucket: 'subscription',
      type: 'grant',
      amount: monthlyCredits,
      now,
      referenceId: subscriptionId,
      note: '套餐月度积分发放',
      metadata: {
        grant_at: grantAt,
        expires_at: expiresAt,
        ...(carryOver ? { carry_over: carryOver } : {}),
      },
    }),
  )
  return {
    ...account,
    subscription_balance: monthlyCredits + carryOver,
    subscription_expires_at: expiresAt,
    updated_at: now,
  }
}

export async function reconcileAccount(tx: Transaction, userId: string, now = Date.now()) {
  await ensureAccount(tx, userId, now)
  let account = await lockAccount(tx, userId)
  if (account.subscription_expires_at !== null && account.subscription_expires_at <= now) {
    account = await expireSubscriptionBalance(tx, account, now, 'monthly-expiry')
  }

  const [subscription] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.user_id, userId), eq(subscriptions.status, 'active')))
    .for('update')
    .limit(1)

  if (!subscription) return { account, subscription: null }
  let plan = await planById(tx, subscription.plan_id)

  let nextGrantAt = subscription.next_grant_at
  let startsAt = subscription.starts_at
  let endsAt = subscription.ends_at
  let planId = subscription.plan_id
  let periodMonths = subscription.period_months
  let scheduledChange = await scheduledChangeFor(tx, subscription)
  // 旧档的月度发放只覆盖到换档生效点。生效点就是当前套餐结束时间，所以未到期时与原来的循环相同。
  const grantUntil =
    scheduledChange && scheduledChange.effective_at < endsAt ? scheduledChange.effective_at : endsAt
  while (nextGrantAt !== null && nextGrantAt <= now && nextGrantAt < grantUntil) {
    account = await expireSubscriptionBalance(tx, account, now, subscription.id)
    account = await grantMonthlyCredits(
      tx,
      account,
      plan.monthly_credits,
      nextGrantAt,
      subscription.id,
      now,
    )
    nextGrantAt = nextMonthlyOccurrence(startsAt, nextGrantAt)
  }

  const changeDue =
    scheduledChange !== null && (scheduledChange.effective_at <= now || endsAt <= now)
  if (changeDue && scheduledChange) {
    const fromPlanId = planId
    const effectiveAt = scheduledChange.effective_at <= now ? scheduledChange.effective_at : endsAt
    plan = await planById(tx, scheduledChange.plan_id)
    account = await expireSubscriptionBalance(tx, account, now, subscription.id)
    planId = plan.id
    periodMonths = scheduledChange.period_months
    startsAt = effectiveAt
    endsAt = addCalendarMonths(effectiveAt, scheduledChange.period_months)
    nextGrantAt = effectiveAt
    while (nextGrantAt !== null && nextGrantAt <= now && nextGrantAt < endsAt) {
      account = await expireSubscriptionBalance(tx, account, now, subscription.id)
      account = await grantMonthlyCredits(
        tx,
        account,
        plan.monthly_credits,
        nextGrantAt,
        subscription.id,
        now,
      )
      nextGrantAt = nextMonthlyOccurrence(startsAt, nextGrantAt)
    }
    // 换档实际生效的时间可能被续费或改到期挪过，订单上的周期按真正生效的那段改写，和订阅一致。
    if (subscription.scheduled_order_id) {
      await tx
        .update(purchaseOrders)
        .set({ starts_at: effectiveAt, ends_at: endsAt })
        .where(eq(purchaseOrders.id, subscription.scheduled_order_id))
    }
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: 'billing',
      action: 'billing.subscription.plan_change',
      target_type: 'user',
      target_id: userId,
      details: {
        from_plan_id: fromPlanId,
        plan_id: planId,
        period_months: periodMonths,
        effective_at: effectiveAt,
        ends_at: endsAt,
        order_id: subscription.scheduled_order_id,
      },
      created_at: now,
    })
    scheduledChange = null
  }

  const expired = endsAt <= now
  if (expired && account.subscription_balance > 0) {
    account = await expireSubscriptionBalance(tx, account, now, subscription.id)
  }
  if (changeDue || nextGrantAt !== subscription.next_grant_at || expired) {
    await tx
      .update(subscriptions)
      .set({
        plan_id: planId,
        period_months: periodMonths,
        starts_at: startsAt,
        ends_at: endsAt,
        next_grant_at: nextGrantAt,
        status: expired ? 'expired' : 'active',
        scheduled_plan_id: scheduledChange?.plan_id ?? null,
        scheduled_period_months: scheduledChange?.period_months ?? null,
        scheduled_effective_at: scheduledChange?.effective_at ?? null,
        scheduled_order_id: changeDue ? null : subscription.scheduled_order_id,
        updated_at: now,
      })
      .where(eq(subscriptions.id, subscription.id))
  }
  return {
    account,
    subscription: {
      ...subscription,
      plan_id: planId,
      period_months: periodMonths as 1 | 3 | 12,
      starts_at: startsAt,
      ends_at: endsAt,
      next_grant_at: nextGrantAt,
      status: expired ? 'expired' : 'active',
      scheduled_plan_id: scheduledChange?.plan_id ?? null,
      scheduled_period_months: scheduledChange?.period_months ?? null,
      scheduled_effective_at: scheduledChange?.effective_at ?? null,
      scheduled_order_id: changeDue ? null : subscription.scheduled_order_id,
      plan,
      scheduled_change: scheduledChange,
    },
  }
}

async function planById(tx: Transaction, planId: string) {
  const [plan] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1)
  if (!plan) throw new Error(`billing plan missing: ${planId}`)
  return plan
}

async function scheduledChangeFor(
  tx: Transaction,
  subscription: typeof subscriptions.$inferSelect,
): Promise<ScheduledPlanChange | null> {
  if (
    !subscription.scheduled_plan_id ||
    subscription.scheduled_period_months === null ||
    subscription.scheduled_effective_at === null
  ) {
    return null
  }
  const period = subscription.scheduled_period_months
  if (period !== 1 && period !== 3 && period !== 12) throw new Error('invalid_period')
  const plan = await planById(tx, subscription.scheduled_plan_id)
  return {
    plan_id: plan.id,
    plan_name: plan.name,
    period_months: period,
    effective_at: subscription.scheduled_effective_at,
  }
}

async function reserveTask(
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

async function finalizeTask(input: Parameters<PrivateTaskHooks['finalizeTask']>[0]): Promise<void> {
  if (!isCapabilityEnabled('billing:credits')) return
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
async function taskCredits(input: {
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

async function onUserCreated(
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

/** Shared subscription eligibility for paid membership checks. */
async function hasActiveSubscription(
  database: Pick<typeof db, 'select'>,
  userId: string,
  now: number,
): Promise<boolean> {
  const [subscription] = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, 'active'),
        lte(subscriptions.starts_at, now),
        gt(subscriptions.ends_at, now),
      ),
    )
    .limit(1)
  return Boolean(subscription)
}
export const privateTaskHooks: PrivateTaskHooks = {
  async canUnlinkOAuthIdentity({ provider }) {
    return { allowed: provider !== 'feishu' }
  },
  async accountSummary({ userId, now }) {
    if (!isCapabilityEnabled('billing:credits')) return { credits: 0, isMember: false }
    const snapshot = await getAccountSnapshot(userId, now)
    return {
      credits: snapshot.account
        ? snapshot.account.subscription_balance + snapshot.account.recharge_balance
        : 0,
      isMember: await hasActiveSubscription(db, userId, now),
      unmetered: snapshot.unmetered?.enabled === true,
    }
  },
  async meteringDecision(input) {
    if (!isCapabilityEnabled('billing:credits')) return { kind: 'metered', metering: 'credits' }
    const entitled = await unmeteredEntitlement(input.tx, input.userId)
    if (entitled)
      return { kind: 'unmetered', metering: 'none', pricing: nonBillingPriceSnapshot(input) }
    if (await feishuWithoutCreditAccount(input.tx, input.userId))
      return { kind: 'denied', reason: 'billing_account_unavailable' }
    return { kind: 'metered', metering: 'credits' }
  },
  consumeUnmeteredQuota,
  async canSubmitTask({ tx, userId, request }) {
    if (request.image_size !== '4K') return true
    if (!isCapabilityEnabled('billing:credits')) return false
    if (await unmeteredEntitlement(tx, userId)) return true
    return hasActiveSubscription(tx, userId, Date.now())
  },

  async quoteTokenTask({ tx, model, estimatedInputTokens }) {
    if (!isCapabilityEnabled('billing:credits')) return null
    if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) return null
    const [price] = await tx
      .select()
      .from(modelPrices)
      .where(and(eq(modelPrices.model, model), eq(modelPrices.unit, 'kilo_token')))
      .limit(1)
      .for('share')
    if (
      !price ||
      !(await modelAvailabilityActive(tx, model)) ||
      price.credits_per_image <= 0 ||
      !price.output_credits_per_unit ||
      price.output_credits_per_unit <= 0 ||
      !price.output_reserve_tokens ||
      price.output_reserve_tokens <= 0 ||
      price.cached_input_price_percent < 0 ||
      price.cached_input_price_percent > 100
    )
      return null
    const rates = {
      outputPriceRatio: price.output_credits_per_unit / price.credits_per_image,
      outputReserveTokens: price.output_reserve_tokens,
      cachedInputPriceRatio: price.cached_input_price_percent / 100,
    }
    const usage = reservedTokenUsage(estimatedInputTokens, rates)
    const exemption = !isCapabilityEnabled('billing:credits')
      ? ('non-billing' as const)
      : isCapabilityEnabled('billing:chat-free')
        ? ('chat-free' as const)
        : ('none' as const)
    return {
      estimatedCredits: creditsFor({ creditsPerUnit: price.credits_per_image, ...usage }),
      pricing: {
        model,
        unit: 'kilo_token' as const,
        ...usage,
        baseUnitCredits: price.credits_per_image,
        ...rates,
        inputEstimateTokens: estimatedInputTokens,
        exemption,
        pricingVersion: createHash('sha256')
          .update(JSON.stringify({ price, exemption }))
          .digest('hex'),
        quotedAt: Date.now(),
        validUntil: null,
      },
    }
  },
  async quoteTask({ tx, model, quantity, unitMultiplier }) {
    if (!isCapabilityEnabled('billing:credits')) return null
    const [price] = await tx
      .select()
      .from(modelPrices)
      .where(and(eq(modelPrices.model, model), inArray(modelPrices.unit, ['image', 'second'])))
      .limit(1)
      .for('share')
    if (!price || !(await modelAvailabilityActive(tx, model))) return null
    const pricingVersion = createHash('sha256').update(JSON.stringify(price)).digest('hex')
    return {
      estimatedCredits: creditsFor({
        creditsPerUnit: price.credits_per_image,
        quantity,
        unitMultiplier,
      }),
      pricing: {
        model,
        unit: price.unit,
        quantity,
        unitMultiplier,
        baseUnitCredits: price.credits_per_image,
        outputPriceRatio: 0,
        cachedInputPriceRatio: price.cached_input_price_percent / 100,
        inputEstimateTokens: 0,
        outputReserveTokens: 0,
        exemption: 'none',
        pricingVersion,
        quotedAt: Date.now(),
        // A later confirmation must revalidate pricingVersion in its reservation transaction.
        validUntil: null,
      },
    }
  },
  reserveTask,
  finalizeTask,
  chatPricing: getChatPricing,
  taskCredits,
  /** GPT 直连选路与会员档位用：此刻有没有生效的订阅。 */
  async isActiveMember({ userId, now }) {
    if (!isCapabilityEnabled('billing:credits')) return false
    return hasActiveSubscription(db, userId, now)
  },
  async accountConcurrencyLimit({ tx, userId, now }) {
    if (!isCapabilityEnabled('billing:credits')) return 3
    const unmetered = await unmeteredEntitlement(tx, userId)
    if (unmetered) return unmetered.guaranteed_concurrency
    const [entitlement] = await tx
      .select({ limit: plans.max_concurrent_tasks })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.user_id, userId),
          eq(subscriptions.status, 'active'),
          lte(subscriptions.starts_at, now),
          gt(subscriptions.ends_at, now),
        ),
      )
      .limit(1)
    return entitlement?.limit ?? 1
  },
  async accountConcurrencyEntitlement({ tx, userId, now }) {
    if (!isCapabilityEnabled('billing:credits')) return { guaranteed: 3, idle: 3 }
    const unmetered = await unmeteredEntitlement(tx, userId)
    if (unmetered)
      return { guaranteed: unmetered.guaranteed_concurrency, idle: unmetered.idle_concurrency }
    const [entitlement] = await tx
      .select({ guaranteed: plans.max_concurrent_tasks, idle: plans.idle_concurrent_tasks })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.user_id, userId),
          eq(subscriptions.status, 'active'),
          lte(subscriptions.starts_at, now),
          gt(subscriptions.ends_at, now),
        ),
      )
      .limit(1)
    // 没有有效订阅：保证 1、不给弹性名额。
    if (!entitlement) return { guaranteed: 1, idle: 1 }
    return {
      guaranteed: entitlement.guaranteed,
      idle: Math.max(entitlement.guaranteed, entitlement.idle ?? entitlement.guaranteed),
    }
  },
  onUserCreated,
  async runMaintenance(now) {
    if (!isCapabilityEnabled('billing:credits')) return
    await scanDueAccounts(now)
  },
  async runWorkerMaintenance(now) {
    if (!isCapabilityEnabled('billing:credits')) return
    await notifyNewOrders(now)
  },
}

const ledgerWithTaskSpend = {
  ...getTableColumns(creditLedger),
  task_net_spend: taskHolds.net_spend,
  task_hold_status: taskHolds.status,
  task_settled_at: taskHolds.settled_at,
  task_kind: sql<
    'analysis' | null
  >`CASE WHEN EXISTS (SELECT 1 FROM ${publicSchema.analysis_tasks} WHERE ${publicSchema.analysis_tasks.task_id} = ${creditLedger.task_id}) THEN 'analysis' ELSE NULL END`,
}

export async function getAccountSnapshot(userId: string, now = Date.now()) {
  return db.transaction(async (tx) => {
    const entitlement = await unmeteredEntitlement(tx, userId)
    const denied = !entitlement && (await feishuWithoutCreditAccount(tx, userId))
    const state = entitlement || denied ? null : await reconcileAccount(tx, userId, now)
    const ledger =
      entitlement || denied
        ? []
        : await tx
            .select(ledgerWithTaskSpend)
            .from(creditLedger)
            .leftJoin(taskHolds, eq(creditLedger.task_id, taskHolds.task_id))
            .where(eq(creditLedger.user_id, userId))
            .orderBy(desc(creditLedger.created_at), desc(creditLedger.id))
            .limit(100)
    const availability = await tx.select().from(publicSchema.model_availability)
    const availabilityByModel = new Map(availability.map((row) => [row.model, row.active]))
    const prices = (await tx.select().from(modelPrices))
      .filter((price) => availabilityByModel.get(price.model) !== false)
      .map((price) => ({ ...price, active: true }))
    return {
      account: state?.account ?? null,
      subscription: state?.subscription ?? null,
      ledger,
      model_prices: prices,
      access_state: denied ? ('access_denied' as const) : null,
      unmetered: entitlement,
    }
  })
}

export async function getLedgerPage(userId: string, offset: number, limit: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error('invalid_pagination')
  }
  const rows = await db
    .select(ledgerWithTaskSpend)
    .from(creditLedger)
    .leftJoin(taskHolds, eq(creditLedger.task_id, taskHolds.task_id))
    .where(eq(creditLedger.user_id, userId))
    .orderBy(desc(creditLedger.created_at), desc(creditLedger.id))
    .offset(offset)
    .limit(limit + 1)
  const hasMore = rows.length > limit
  return {
    ledger: rows.slice(0, limit),
    next_offset: hasMore ? offset + limit : null,
  }
}

/** 一个任务的净消耗：预扣减实际退回。每次调用现造一个，同一个 SQL 片段不能在两处 alias。 */
const netSpendPerTask = () => sql<number>`
  coalesce(sum(-${creditLedger.amount}) filter (where ${creditLedger.entry_type} = 'hold'), 0)
  - coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.entry_type} = 'release'), 0)
`

/**
 * 消耗按天聚合：先按任务把退回净掉，再整笔归到 commit 那天——按天净值会让跨日的退回记出负数。
 * 省略 userId 即全站。
 */
export async function getSpendActivity(input: { userId?: string; from?: string; to?: string }) {
  const timezone = deploymentTimezone
  const range = resolveActivityRange({
    from: input.from,
    to: input.to,
    today: dayInTimezone(Date.now(), timezone),
  })
  const netSpend = netSpendPerTask()
  const perTask = db
    .select({
      day: sql<string>`to_char(min(${creditLedger.created_at}) filter (where ${creditLedger.entry_type} = 'commit') at time zone ${timezone}, 'YYYY-MM-DD')`.as(
        'day',
      ),
      spend: netSpend.as('spend'),
    })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.entry_type, ['hold', 'commit', 'release']),
        isNotNull(creditLedger.task_id),
        input.userId ? eq(creditLedger.user_id, input.userId) : undefined,
      ),
    )
    .groupBy(creditLedger.task_id)
    .having(sql`${netSpend} > 0`)
    .as('per_task')

  const days = await db
    .select({ date: perTask.day, count: sql<number>`sum(${perTask.spend})::int` })
    .from(perTask)
    .where(and(gte(perTask.day, range.from), lte(perTask.day, range.to)))
    .groupBy(perTask.day)
    .orderBy(asc(perTask.day))

  return { ...range, timezone, days }
}

export async function getCatalog(
  options: { includeInactivePlans?: boolean } = {},
  now = Date.now(),
) {
  const planRowsPromise = options.includeInactivePlans
    ? db.select().from(plans).orderBy(asc(plans.sort_order))
    : db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.sort_order))
  const [planRows, priceRows, settingRows, rawModelRows, availabilityRows] = await Promise.all([
    planRowsPromise,
    db.select().from(planPrices),
    db.select().from(billingSettings).where(eq(billingSettings.id, 'default')).limit(1),
    db.select().from(modelPrices).orderBy(asc(modelPrices.model)),
    db
      .select({
        model: publicSchema.model_availability.model,
        active: publicSchema.model_availability.active,
      })
      .from(publicSchema.model_availability),
  ])
  const availabilityByModel = new Map(availabilityRows.map((row) => [row.model, row.active]))
  const modelRows = rawModelRows.map((row) => ({
    ...row,
    active: availabilityByModel.get(row.model) ?? true,
  }))
  return {
    plans: planRows.map((plan) => ({
      ...plan,
      prices: priceRows
        .filter((price) => price.plan_id === plan.id)
        .map((price) => ({
          ...price,
          effective_price_cents: effectivePrice(
            price.original_price_cents,
            price.discount_price_cents,
            price.discount_ends_at,
            now,
          ),
        })),
    })),
    recharge_pricing: {
      credits_per_yuan: rechargeCreditsPerYuan,
      amounts_yuan: [...rechargeAmountsYuan],
    },
    settings: settingRows[0] ?? null,
    model_prices: modelRows,
  }
}

/**
 * 定价页折算张数用的图片模型：先用产品默认的 Image 2.5 Flare，没有上架单价时退回 gpt-image-2。
 * 改默认模型时这份顺序跟着改。
 */
const PUBLIC_IMAGE_ANCHOR_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2'] as const

/** 公开价目。折扣是否生效由服务端按 effectivePrice 算，页面不再自带一份快照。 */
export async function getPublicCatalog(now = Date.now()) {
  const [catalog, referral] = await Promise.all([getCatalog({}, now), getReferralPolicy()])
  const priced = catalog.model_prices.filter(
    (price) => price.active && price.unit === 'image' && price.credits_per_image > 0,
  )
  const anchor = PUBLIC_IMAGE_ANCHOR_MODELS.map((model) =>
    priced.find((price) => price.model === model),
  ).find((price) => price !== undefined)
  return {
    plans: catalog.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      monthly_credits: plan.monthly_credits,
      max_concurrent_tasks: plan.max_concurrent_tasks ?? 1,
      sort_order: plan.sort_order,
      prices: plan.prices.map((price) => ({
        period_months: price.period_months,
        original_price_cents: price.original_price_cents,
        discount_price_cents: price.discount_price_cents,
        discount_ends_at: price.discount_ends_at,
        effective_price_cents: price.effective_price_cents,
      })),
    })),
    recharge: {
      credits_per_yuan: rechargeCreditsPerYuan,
      amounts_yuan: [...rechargeAmountsYuan],
    },
    image_anchor: anchor
      ? { model: anchor.model, credits_per_image: anchor.credits_per_image }
      : null,
    referral,
  }
}

export async function getUserSummaries(userIds: string[]) {
  const uniqueIds = [...new Set(userIds)]
  const relationships =
    uniqueIds.length > 0
      ? await db
          .select({
            user_id: referralRelationships.user_id,
            inviter_user_id: referralRelationships.inviter_user_id,
          })
          .from(referralRelationships)
          .where(inArray(referralRelationships.user_id, uniqueIds))
      : []
  const relationshipByUser = new Map(relationships.map((row) => [row.user_id, row]))
  const inviterIds = [...new Set(relationships.map((row) => row.inviter_user_id))]
  const inviters =
    inviterIds.length > 0
      ? await db
          .select({ user_id: publicSchema.users.id, username: publicSchema.users.username })
          .from(publicSchema.users)
          .where(inArray(publicSchema.users.id, inviterIds))
      : []
  const inviterById = new Map(inviters.map((row) => [row.user_id, row]))

  const summaries = await Promise.all(
    uniqueIds.map(async (userId) => {
      const state = await db.transaction(async (tx) => {
        // Enterprise identities intentionally have no credit account. Reuse the
        // same durable-fact checks as the account snapshot so an admin listing
        // cannot create financial state (or fail in ensureAccount).
        const entitlement = await unmeteredEntitlement(tx, userId)
        const noCreditAccount = await feishuWithoutCreditAccount(tx, userId)
        return entitlement || noCreditAccount ? null : reconcileAccount(tx, userId)
      })
      const relationship = relationshipByUser.get(userId)
      const inviter = relationship ? inviterById.get(relationship.inviter_user_id) : undefined
      return {
        user_id: userId,
        subscription_balance: state?.account?.subscription_balance ?? 0,
        recharge_balance: state?.account?.recharge_balance ?? 0,
        subscription_expires_at: state?.account?.subscription_expires_at ?? null,
        subscription: state?.subscription
          ? {
              plan_id: state.subscription.plan.id,
              plan_name: state.subscription.plan.name,
              ends_at: state.subscription.ends_at,
              status: state.subscription.status,
            }
          : null,
        registration_source: relationship ? ('invited' as const) : ('direct_or_unknown' as const),
        inviter:
          relationship && inviter
            ? { user_id: relationship.inviter_user_id, username: inviter.username }
            : null,
      }
    }),
  )
  return { summaries }
}

export async function getBillingOverview() {
  await scanDueAccounts()
  const [[accountTotals], [activeTotals]] = await Promise.all([
    db
      .select({
        accounts: sql<number>`count(*)::int`,
        subscription_credits: sql<number>`coalesce(sum(${creditAccounts.subscription_balance}), 0)::bigint`,
        recharge_credits: sql<number>`coalesce(sum(${creditAccounts.recharge_balance}), 0)::bigint`,
      })
      .from(creditAccounts),
    db
      .select({ active_subscriptions: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.status, 'active')),
  ])
  return {
    accounts: Number(accountTotals?.accounts ?? 0),
    active_subscriptions: Number(activeTotals?.active_subscriptions ?? 0),
    subscription_credits: Number(accountTotals?.subscription_credits ?? 0),
    recharge_credits: Number(accountTotals?.recharge_credits ?? 0),
  }
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
  tx: Transaction,
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

export interface SubscriptionGrant {
  userId: string
  planId: string
  periodMonths: 1 | 3 | 12
  startsAt: number
  reason: string
  payment: ConfirmedPaymentInput | null
  operatorId?: string
  /**
   * 订单核款传入订单号。当前档不同时，升档（月度积分更高）立即生效，降档记一笔下一周期生效的换档。
   * 运营手动开通不传，仍拒绝 active_subscription_plan_mismatch。
   */
  scheduleOrderId?: string
}

export async function grantSubscription(input: SubscriptionGrant) {
  return db.transaction((tx) => grantSubscriptionInTransaction(tx, input))
}

export async function grantSubscriptionInTransaction(
  tx: Transaction,
  input: SubscriptionGrant,
  lockedOrder = false,
) {
  if (![1, 3, 12].includes(input.periodMonths)) throw new Error('invalid_period')
  const reason = input.reason.trim()
  if (!reason) throw new Error('reason_required')
  if (await unmeteredEntitlement(tx, input.userId)) throw new Error('billing_account_unavailable')
  const now = Date.now()
  const payment = await beginConfirmedPayment(tx, {
    userId: input.userId,
    kind: 'subscription',
    payment: input.payment,
    details: {
      plan_id: input.planId,
      period_months: input.periodMonths,
      starts_at: input.startsAt,
      reason,
    },
    operatorId: input.operatorId ?? OPERATOR_ID,
    now,
  })
  if (payment?.replay) return payment.record.result
  const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId)).limit(1)
  if (!plan) throw new Error('plan_not_found')
  if (!plan.active && !lockedOrder) throw new Error('plan_inactive')
  await reconcileAccount(tx, input.userId, now)
  const [active] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.user_id, input.userId), eq(subscriptions.status, 'active')))
    .for('update')
    .limit(1)
  let subscriptionId: string
  let endsAt: number
  let renewalGrant = false
  if (active && active.plan_id !== plan.id) {
    if (!input.scheduleOrderId) throw new Error('active_subscription_plan_mismatch')
    if (active.scheduled_order_id && active.scheduled_order_id !== input.scheduleOrderId) {
      throw new Error('scheduled_plan_change_exists')
    }
    const current = await planById(tx, active.plan_id)
    if (!active.scheduled_order_id && plan.monthly_credits > current.monthly_credits) {
      // 升档立即生效：新周期从核款时起算，旧档剩余订阅积分并入新档本期，按新档本期到期。
      endsAt = addCalendarMonths(now, input.periodMonths)
      await tx
        .update(subscriptions)
        .set({
          plan_id: plan.id,
          period_months: input.periodMonths,
          starts_at: now,
          ends_at: endsAt,
          next_grant_at: addCalendarMonths(now, 1),
          updated_at: now,
        })
        .where(eq(subscriptions.id, active.id))
      const account = await lockAccount(tx, input.userId)
      await grantMonthlyCredits(
        tx,
        account,
        plan.monthly_credits,
        now,
        active.id,
        now,
        account.subscription_balance,
      )
      await tx.insert(publicSchema.operator_audits).values({
        id: randomUUID(),
        operator_id: input.operatorId ?? OPERATOR_ID,
        action: 'billing.subscription.upgrade',
        target_type: 'user',
        target_id: input.userId,
        details: {
          plan_id: plan.id,
          from_plan_id: active.plan_id,
          period_months: input.periodMonths,
          starts_at: now,
          ends_at: endsAt,
          previous_ends_at: active.ends_at,
          carried_over_credits: account.subscription_balance,
          reason,
          payment_id: payment?.record.id ?? null,
        },
        created_at: now,
      })
      const outcome = {
        subscription_id: active.id,
        ends_at: endsAt,
        effective_at: now,
        action: 'upgrade' as const,
      }
      if (payment) {
        await tx
          .update(confirmedPayments)
          .set({ result: outcome })
          .where(eq(confirmedPayments.id, payment.record.id))
      }
      return outcome
    }
    // 降档不改当前周期：旧套餐与已发放额度继续用到 ends_at，届时 reconcile 切到新档并发放新额度。
    const effectiveAt = active.ends_at
    if (active.scheduled_order_id !== input.scheduleOrderId) {
      await tx
        .update(subscriptions)
        .set({
          scheduled_plan_id: plan.id,
          scheduled_period_months: input.periodMonths,
          scheduled_effective_at: effectiveAt,
          scheduled_order_id: input.scheduleOrderId,
          updated_at: now,
        })
        .where(eq(subscriptions.id, active.id))
      await tx.insert(publicSchema.operator_audits).values({
        id: randomUUID(),
        operator_id: input.operatorId ?? OPERATOR_ID,
        action: 'billing.subscription.schedule_change',
        target_type: 'user',
        target_id: input.userId,
        details: {
          plan_id: plan.id,
          current_plan_id: active.plan_id,
          period_months: input.periodMonths,
          effective_at: effectiveAt,
          reason,
          payment_id: payment?.record.id ?? null,
        },
        created_at: now,
      })
    }
    const outcome = {
      subscription_id: active.id,
      ends_at: active.ends_at,
      effective_at: effectiveAt,
      action: 'schedule' as const,
    }
    if (payment) {
      await tx
        .update(confirmedPayments)
        .set({ result: outcome })
        .where(eq(confirmedPayments.id, payment.record.id))
    }
    return outcome
  }
  if (active) {
    if (input.startsAt > active.ends_at) throw new Error('renewal_start_after_current_end')
    subscriptionId = active.id
    endsAt = addCalendarMonths(active.ends_at, input.periodMonths)
    // 续费当天补发当月额度，并把月度发放日改为今天；有效期仍叠加在当前截止日之后。
    // 套餐余额已达到月额度（含运营补发后超出）时不重发，避免清零后反而变少；订阅尚未开始也不发。
    const account = await lockAccount(tx, input.userId)
    renewalGrant = active.starts_at <= now && account.subscription_balance < plan.monthly_credits
    await tx
      .update(subscriptions)
      .set({
        ends_at: endsAt,
        updated_at: now,
        ...(renewalGrant ? { starts_at: now, next_grant_at: addCalendarMonths(now, 1) } : {}),
        // 续费只延长当前档。已预约的换档跟着新的到期时间走，避免提前切档。
        ...(active.scheduled_plan_id ? { scheduled_effective_at: endsAt } : {}),
      })
      .where(eq(subscriptions.id, active.id))
    if (renewalGrant) {
      const cleared = await expireSubscriptionBalance(tx, account, now, subscriptionId)
      await grantMonthlyCredits(tx, cleared, plan.monthly_credits, now, subscriptionId, now)
    }
  } else {
    subscriptionId = randomUUID()
    endsAt = addCalendarMonths(input.startsAt, input.periodMonths)
    const grantNow = input.startsAt <= now
    const nextGrantAt = grantNow ? addCalendarMonths(input.startsAt, 1) : input.startsAt
    await tx.insert(subscriptions).values({
      id: subscriptionId,
      user_id: input.userId,
      plan_id: plan.id,
      period_months: input.periodMonths,
      starts_at: input.startsAt,
      ends_at: endsAt,
      next_grant_at: nextGrantAt,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    if (grantNow) {
      let account = await lockAccount(tx, input.userId)
      account = await expireSubscriptionBalance(tx, account, now, subscriptionId)
      await grantMonthlyCredits(
        tx,
        account,
        plan.monthly_credits,
        input.startsAt,
        subscriptionId,
        now,
      )
    }
  }
  await tx.insert(publicSchema.operator_audits).values({
    id: randomUUID(),
    operator_id: input.operatorId ?? OPERATOR_ID,
    action: active ? 'billing.subscription.renew' : 'billing.subscription.grant',
    target_type: 'user',
    target_id: input.userId,
    details: {
      plan_id: input.planId,
      period_months: input.periodMonths,
      starts_at: input.startsAt,
      ends_at: endsAt,
      reason,
      renewal_grant: renewalGrant,
      payment_id: payment?.record.id ?? null,
    },
    created_at: now,
  })
  const outcome = {
    subscription_id: subscriptionId,
    ends_at: endsAt,
    action: (active ? 'renew' : 'grant') as 'renew' | 'grant',
  }
  if (payment) {
    await tx
      .update(confirmedPayments)
      .set({ result: outcome })
      .where(eq(confirmedPayments.id, payment.record.id))
  }
  return outcome
}

export async function adjustSubscriptionExpiry(input: {
  subscriptionId: string
  endsAt: number
  reason: string
  operatorId?: string
}) {
  if (!Number.isSafeInteger(input.endsAt) || input.endsAt <= Date.now()) {
    throw new Error('invalid_expiry')
  }
  if (!input.reason.trim()) throw new Error('reason_required')
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ user_id: subscriptions.user_id })
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1)
    if (!owner) throw new Error('subscription_not_found')
    // 与 reconcileAccount 相同的锁序：先账户，后订阅。
    const account = await lockAccount(tx, owner.user_id)
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.status, 'active')))
      .for('update')
      .limit(1)
    if (!subscription) throw new Error('subscription_not_found')
    const now = Date.now()
    // 月度发放日以新截止日往前每满一个月为界：套餐积分到期日与下次发放日取最近的未到界，
    // 截止日改到哪天，积分就跟到哪个周期，不会按旧发放日多发一次。
    let boundary = input.endsAt
    while (addCalendarMonths(boundary, -1) > now) boundary = addCalendarMonths(boundary, -1)
    const nextGrantAt = boundary < input.endsAt ? boundary : null
    const startsAt = Math.min(subscription.starts_at, addCalendarMonths(boundary, -1))
    const pointsExpiresAt = account.subscription_balance > 0 ? boundary : null
    await tx
      .update(subscriptions)
      .set({
        ends_at: input.endsAt,
        starts_at: startsAt,
        next_grant_at: nextGrantAt,
        updated_at: now,
        ...(subscription.scheduled_plan_id ? { scheduled_effective_at: input.endsAt } : {}),
      })
      .where(eq(subscriptions.id, subscription.id))
    if (pointsExpiresAt !== null) {
      await tx
        .update(creditAccounts)
        .set({ subscription_expires_at: pointsExpiresAt, updated_at: now })
        .where(eq(creditAccounts.user_id, owner.user_id))
    }
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.subscription.expiry_adjust',
      target_type: 'subscription',
      target_id: subscription.id,
      details: {
        user_id: subscription.user_id,
        previous_ends_at: subscription.ends_at,
        ends_at: input.endsAt,
        previous_next_grant_at: subscription.next_grant_at,
        next_grant_at: nextGrantAt,
        previous_credits_expires_at: account.subscription_expires_at,
        credits_expires_at: pointsExpiresAt ?? account.subscription_expires_at,
        reason: input.reason,
      },
      created_at: now,
    })
    return { subscription_id: subscription.id, ends_at: input.endsAt }
  })
}

export interface SubscriptionCreditAdjustment {
  userId: string
  amount: number
  reason: string
  operatorId?: string
}

/**
 * 运营补发或扣减套餐积分。补发的额度沿用套餐桶现有的到期时间；桶里没有未过期的到期时间时，
 * 取下一次月度发放日，没有下一次发放则取套餐截止。到期或下次月度发放时照常清零重发。
 */
export async function adjustSubscriptionCredits(input: SubscriptionCreditAdjustment) {
  if (
    !Number.isInteger(input.amount) ||
    input.amount === 0 ||
    Math.abs(input.amount) > MAX_CREDIT_BALANCE
  ) {
    throw new Error('invalid_amount')
  }
  const reason = input.reason.trim()
  if (!reason) throw new Error('reason_required')
  return db.transaction(async (tx) => {
    if (await unmeteredEntitlement(tx, input.userId)) throw new Error('billing_account_unavailable')
    const now = Date.now()
    const { account, subscription } = await reconcileAccount(tx, input.userId, now)
    const balance = account.subscription_balance + input.amount
    if (balance < 0) throw new Error('insufficient_subscription_credits')
    if (balance > MAX_CREDIT_BALANCE) throw new Error('credit_balance_overflow')
    let expiresAt = account.subscription_expires_at
    if (input.amount > 0) {
      if (!subscription || subscription.status !== 'active' || subscription.starts_at > now) {
        throw new Error('no_active_subscription')
      }
      if (expiresAt === null || expiresAt <= now) {
        expiresAt =
          subscription.next_grant_at !== null && subscription.next_grant_at < subscription.ends_at
            ? subscription.next_grant_at
            : subscription.ends_at
      }
    }
    await tx
      .update(creditAccounts)
      .set({ subscription_balance: balance, subscription_expires_at: expiresAt, updated_at: now })
      .where(eq(creditAccounts.user_id, input.userId))
    await tx.insert(creditLedger).values(
      ledgerRow({
        userId: input.userId,
        bucket: 'subscription',
        type: 'adjustment',
        amount: input.amount,
        now,
        operatorId: input.operatorId ?? OPERATOR_ID,
        note: reason,
        metadata: { expires_at: expiresAt },
      }),
    )
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.credits.adjust_subscription',
      target_type: 'user',
      target_id: input.userId,
      details: { amount: input.amount, reason, expires_at: expiresAt },
      created_at: now,
    })
    return reconcileAccount(tx, input.userId, now)
  })
}

export interface ModelPriceUpdate {
  operatorId?: string
  model: string
  /** unit 为 kilo_token 时是每千输入 token 的积分数。 */
  creditsPerUnit: number
  unit?: ModelPriceUnit
  /** 对话模型必填：每千输出 token 的积分数与一轮预扣的输出 token 上限。 */
  outputCreditsPerUnit?: number
  outputReserveTokens?: number
  cachedInputPricePercent?: number
}

const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

export async function updateModelPrice(input: ModelPriceUpdate) {
  const { model, creditsPerUnit } = input
  const unit: ModelPriceUnit = input.unit ?? 'image'
  if (!positive(creditsPerUnit)) throw new Error('invalid_price')
  const chat = unit === 'kilo_token'
  const outputCreditsPerUnit = chat ? (input.outputCreditsPerUnit ?? 0) : null
  const outputReserveTokens = chat ? (input.outputReserveTokens ?? 0) : null
  if (chat && !(positive(outputCreditsPerUnit) && positive(outputReserveTokens))) {
    throw new Error('invalid_chat_pricing')
  }
  if (
    input.cachedInputPricePercent !== undefined &&
    (!Number.isInteger(input.cachedInputPricePercent) ||
      input.cachedInputPricePercent < 0 ||
      input.cachedInputPricePercent > 100)
  ) {
    throw new Error('invalid_cached_input_price')
  }
  const cachedPrice =
    input.cachedInputPricePercent === undefined
      ? {}
      : { cached_input_price_percent: input.cachedInputPricePercent }
  const now = Date.now()
  const row = {
    ...cachedPrice,
    credits_per_image: creditsPerUnit,
    unit,
    output_credits_per_unit: outputCreditsPerUnit,
    output_reserve_tokens: outputReserveTokens,
    updated_at: now,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(modelPrices)
      .values({ model, active: true, ...row })
      .onConflictDoUpdate({ target: modelPrices.model, set: row })
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.model_price.update',
      target_type: 'model',
      target_id: model,
      details: {
        ...cachedPrice,
        credits_per_image: creditsPerUnit,
        unit,
        ...(chat
          ? {
              output_credits_per_unit: outputCreditsPerUnit,
              output_reserve_tokens: outputReserveTokens,
            }
          : {}),
      },
      created_at: now,
    })
  })
}

/**
 * 公开树拿倍数与预留来折算 token；原价由私有账本按起轮时的单价快照计算。
 */
export async function getChatPricing(model: string, tx?: Transaction) {
  if (!isCapabilityEnabled('billing:credits')) return null
  const [price] = await (tx ?? db)
    .select()
    .from(modelPrices)
    .where(and(eq(modelPrices.model, model), eq(modelPrices.unit, 'kilo_token')))
    .limit(1)
  if (!price?.output_credits_per_unit || !price.output_reserve_tokens) return null
  const creditsPerUnit = price.credits_per_image
  return {
    cachedInputPriceRatio: price.cached_input_price_percent / 100,
    outputPriceRatio: price.output_credits_per_unit / creditsPerUnit,
    outputReserveTokens: price.output_reserve_tokens,
    quoteCredits(reserved: TaskUsage, actual?: TaskUsage) {
      const reservedAmount = creditsFor({ creditsPerUnit, ...reserved })
      return actual ? settledAmount({ creditsPerUnit, ...actual, reservedAmount }) : reservedAmount
    },
  }
}

/** 对话消耗汇总：省略 userId 即全站。只出数字，会话标题与消息内容不进后台。 */
export async function getChatUsageSummary(userId?: string) {
  const chatModels = db
    .select({ model: modelPrices.model })
    .from(modelPrices)
    .where(eq(modelPrices.unit, 'kilo_token'))
  // 先按模型收窄再聚合：不筛的话每次汇总都要把整张账本（绝大多数是生图）分组一遍。
  const perTask = db
    .select({ task_id: creditLedger.task_id, spend: netSpendPerTask().as('spend') })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.entry_type, ['hold', 'commit', 'release']),
        isNotNull(creditLedger.task_id),
        inArray(creditLedger.model, chatModels),
        userId ? eq(creditLedger.user_id, userId) : undefined,
      ),
    )
    .groupBy(creditLedger.task_id)
    .as('per_task')

  const [totals] = await db
    .select({
      turns: sql<number>`count(*)::int`,
      input_tokens: sql<number>`coalesce(sum(${taskHolds.input_tokens}), 0)::bigint`,
      output_tokens: sql<number>`coalesce(sum(${taskHolds.output_tokens}), 0)::bigint`,
      credits: sql<number>`coalesce(sum(${perTask.spend}), 0)::bigint`,
    })
    .from(taskHolds)
    .innerJoin(
      modelPrices,
      and(eq(modelPrices.model, taskHolds.model), eq(modelPrices.unit, 'kilo_token')),
    )
    .leftJoin(perTask, eq(perTask.task_id, taskHolds.task_id))
    .where(
      and(
        eq(taskHolds.status, 'committed'),
        userId ? eq(taskHolds.user_id, userId) : undefined,
        // Independent analysis facts remain after transient task cleanup; token pricing alone is not a chat turn.
        notExists(
          db
            .select({ id: publicSchema.analysis_tasks.task_id })
            .from(publicSchema.analysis_tasks)
            .where(eq(publicSchema.analysis_tasks.task_id, taskHolds.task_id)),
        ),
      ),
    )
  return {
    turns: Number(totals?.turns ?? 0),
    input_tokens: Number(totals?.input_tokens ?? 0),
    output_tokens: Number(totals?.output_tokens ?? 0),
    credits: Number(totals?.credits ?? 0),
  }
}

const SHIPPED_CHAT_PRICE = {
  credits_per_image: 6,
  unit: 'kilo_token' as const,
  output_credits_per_unit: 30,
  output_reserve_tokens: 2_000,
}

/** 后台只编辑已有的行，所以对话模型得先有一行运营才配得上。 */
export async function ensureChatModelPrice(): Promise<void> {
  if (!isCapabilityEnabled('agent:chat') || !config.agent.model) return
  await db
    .insert(modelPrices)
    .values({
      model: config.agent.model,
      ...SHIPPED_CHAT_PRICE,
      active: true,
      updated_at: Date.now(),
    })
    .onConflictDoNothing()
}

export async function syncModelPricesFromChannels(): Promise<void> {
  if (!isCapabilityEnabled('billing:credits')) return
  const units = new Map<string, ModelPriceUnit>()
  for (const channel of getChannels()) {
    for (const model of channel.models) {
      units.set(model.id, model.media === 'video' ? 'second' : 'image')
    }
  }
  if (units.size === 0) return
  const now = Date.now()
  await db
    .insert(modelPrices)
    .values(
      Array.from(units, ([model, unit]) => ({
        model,
        credits_per_image: 100,
        unit,
        active: true,
        updated_at: now,
      })),
    )
    // 单价与启用状态归运营，计价单位跟着 channel 的 media 走，所以只有它覆盖既有行。
    // 对话那一行除外：改成 image 会让对话定价静默失效，而哪里都不报错。
    .onConflictDoUpdate({
      target: modelPrices.model,
      set: { unit: sql`excluded.unit` },
      setWhere: sql`${modelPrices.unit} <> 'kilo_token'`,
    })
}

export async function updatePlan(input: {
  operatorId?: string
  id: string
  name: string
  monthlyCredits: number
  maxConcurrentTasks?: number
  active: boolean
  sortOrder: number
  prices: Array<{
    periodMonths: 1 | 3 | 12
    originalPriceCents: number
    discountPriceCents: number | null
    discountEndsAt: number | null
  }>
}) {
  if (
    input.prices.some((price) => price.discountPriceCents !== null && price.discountEndsAt === null)
  ) {
    throw new Error('discount_deadline_required')
  }
  const now = Date.now()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan:${input.id}`}))`)
    const [previous] = await tx.select().from(plans).where(eq(plans.id, input.id)).for('update')
    const concurrency = input.maxConcurrentTasks ?? previous?.max_concurrent_tasks ?? 1
    const newVersion =
      previous &&
      (previous.monthly_credits !== input.monthlyCredits ||
        previous.max_concurrent_tasks !== concurrency)
    const planId = newVersion ? `${input.id}-${randomUUID().slice(0, 8)}` : input.id
    // 新版本沿用旧版的空闲并发；保证并发调到不小于它时就没必要再给，置空。
    const idleConcurrency =
      previous?.idle_concurrent_tasks != null && previous.idle_concurrent_tasks > concurrency
        ? previous.idle_concurrent_tasks
        : null
    if (newVersion)
      await tx.update(plans).set({ active: false, updated_at: now }).where(eq(plans.id, input.id))

    await tx
      .insert(plans)
      .values({
        id: planId,
        name: input.name,
        monthly_credits: input.monthlyCredits,
        max_concurrent_tasks: concurrency,
        idle_concurrent_tasks: idleConcurrency,
        active: input.active,
        sort_order: input.sortOrder,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: plans.id,
        set: {
          name: input.name,
          monthly_credits: input.monthlyCredits,
          max_concurrent_tasks: concurrency,
          active: input.active,
          sort_order: input.sortOrder,
          updated_at: now,
        },
      })
    for (const price of input.prices) {
      await tx
        .insert(planPrices)
        .values({
          plan_id: planId,
          period_months: price.periodMonths,
          original_price_cents: price.originalPriceCents,
          discount_price_cents: price.discountPriceCents,
          discount_ends_at: price.discountEndsAt,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [planPrices.plan_id, planPrices.period_months],
          set: {
            original_price_cents: price.originalPriceCents,
            discount_price_cents: price.discountPriceCents,
            discount_ends_at: price.discountEndsAt,
            updated_at: now,
          },
        })
    }
    const periods = input.prices.map((price) => price.periodMonths)
    await tx
      .delete(planPrices)
      .where(
        periods.length === 0
          ? eq(planPrices.plan_id, planId)
          : and(eq(planPrices.plan_id, planId), notInArray(planPrices.period_months, periods)),
      )
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.plan.update',
      target_type: 'plan',
      target_id: planId,
      details: { ...input, previous_plan_id: newVersion ? input.id : null },
      created_at: now,
    })
    return planId
  })
}

export async function updateSettings(input: {
  operatorId?: string
  paymentsEnabled?: boolean
  paymentChannel?: 'wechat' | 'alipay'
  receivingAccount?: string
  contactWechat: string
  paymentQrUrl: string
  contactQrUrl: string
  guidance: string
}) {
  const now = Date.now()
  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(billingSettings)
      .where(eq(billingSettings.id, 'default'))
      .for('update')
    const channel = input.paymentChannel ?? previous?.payment_channel ?? 'wechat'
    const account = input.receivingAccount?.trim() ?? previous?.receiving_account ?? ''
    const enabled = input.paymentsEnabled ?? previous?.payments_enabled ?? false
    if (enabled && (!account || !input.paymentQrUrl.trim()))
      throw new Error('payment_configuration_required')
    const codeId =
      previous?.payment_code_id &&
      previous.payment_qr_url === input.paymentQrUrl &&
      previous.payment_channel === channel &&
      previous.receiving_account === account
        ? previous.payment_code_id
        : randomUUID()
    const paymentConfig = {
      payments_enabled: enabled,
      payment_channel: channel,
      receiving_account: account,
      payment_code_id: codeId,
    }

    await tx
      .insert(billingSettings)
      .values({
        id: 'default',
        ...paymentConfig,
        contact_wechat: input.contactWechat,
        payment_qr_url: input.paymentQrUrl,
        contact_qr_url: input.contactQrUrl,
        guidance: input.guidance,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: billingSettings.id,
        set: {
          ...paymentConfig,
          contact_wechat: input.contactWechat,
          payment_qr_url: input.paymentQrUrl,
          contact_qr_url: input.contactQrUrl,
          guidance: input.guidance,
          updated_at: now,
        },
      })
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.settings.update',
      target_type: 'billing_settings',
      target_id: 'default',
      details: input,
      created_at: now,
    })
  })
}

export async function scanDueAccounts(now = Date.now()): Promise<number> {
  const due = await db
    .select({ userId: subscriptions.user_id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, 'active'),
        or(
          lte(subscriptions.next_grant_at, now),
          lte(subscriptions.ends_at, now),
          lte(subscriptions.scheduled_effective_at, now),
        ),
      ),
    )
  for (const row of due) await db.transaction((tx) => reconcileAccount(tx, row.userId, now))
  return due.length
}
