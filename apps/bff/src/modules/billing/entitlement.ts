import { randomUUID } from 'node:crypto'
import {
  accountFacts,
  creditAccounts,
  creditLedger,
  plans,
  purchaseOrders,
  subscriptions,
  unmeteredEntitlements,
  unmeteredQuota,
} from '@image-playground/db/billing'
import type { ScheduledPlanChange } from '@image-playground/shared'
import { and, eq, gt, lte, or, sql } from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import type { BffTransaction, PrivateTaskHooks } from '../../lib/billing-hooks'
import { nonBillingPriceSnapshot } from '../../lib/billing-hooks'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { ensureAccount, lockAccount } from './accounts'
import { addCalendarMonths, ceilCredits, nextMonthlyOccurrence } from './calculations'
import { ledgerRow } from './settlement'

export type BillingTransaction = BffTransaction

export async function unmeteredEntitlement(tx: BillingTransaction, userId: string) {
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

export async function feishuWithoutCreditAccount(
  tx: BillingTransaction,
  userId: string,
): Promise<boolean> {
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

function quotaResetAt(now: number): string {
  const next = new Date(now)
  next.setUTCHours(0, 0, 0, 0)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}

export async function consumeUnmeteredQuota(
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

export async function expireSubscriptionBalance(
  tx: BillingTransaction,
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

export async function grantMonthlyCredits(
  tx: BillingTransaction,
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

export async function planById(tx: BillingTransaction, planId: string) {
  const [plan] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1)
  if (!plan) throw new Error(`billing plan missing: ${planId}`)
  return plan
}

async function scheduledChangeFor(
  tx: BillingTransaction,
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

export async function reconcileAccount(tx: BillingTransaction, userId: string, now = Date.now()) {
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

/** Shared subscription eligibility for paid membership checks. */
export async function hasActiveSubscription(
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

export async function canUnlinkOAuthIdentity(
  input: Parameters<NonNullable<PrivateTaskHooks['canUnlinkOAuthIdentity']>>[0],
) {
  if (!isCapabilityEnabled('billing:credits')) return { allowed: true }
  return { allowed: input.provider !== 'feishu' }
}

export async function meteringDecision(
  input: Parameters<NonNullable<PrivateTaskHooks['meteringDecision']>>[0],
) {
  if (!isCapabilityEnabled('billing:credits'))
    return { kind: 'metered' as const, metering: 'credits' as const }
  const entitled = await unmeteredEntitlement(input.tx, input.userId)
  if (entitled)
    return {
      kind: 'unmetered' as const,
      metering: 'none' as const,
      pricing: nonBillingPriceSnapshot(input),
    }
  if (await feishuWithoutCreditAccount(input.tx, input.userId))
    return { kind: 'denied' as const, reason: 'billing_account_unavailable' }
  return { kind: 'metered' as const, metering: 'credits' as const }
}

export async function canSubmitTask(
  input: Parameters<NonNullable<PrivateTaskHooks['canSubmitTask']>>[0],
): Promise<boolean> {
  if (input.request.image_size !== '4K') return true
  if (!isCapabilityEnabled('billing:credits')) return false
  if (await unmeteredEntitlement(input.tx, input.userId)) return true
  return hasActiveSubscription(input.tx, input.userId, Date.now())
}

/** GPT 直连选路与会员档位用：此刻有没有生效的订阅。 */
export async function isActiveMember(
  input: Parameters<NonNullable<PrivateTaskHooks['isActiveMember']>>[0],
): Promise<boolean> {
  if (!isCapabilityEnabled('billing:credits')) return false
  return hasActiveSubscription(db, input.userId, input.now)
}

export async function accountConcurrencyLimit(
  input: Parameters<NonNullable<PrivateTaskHooks['accountConcurrencyLimit']>>[0],
): Promise<number> {
  if (!isCapabilityEnabled('billing:credits')) return 3
  const unmetered = await unmeteredEntitlement(input.tx, input.userId)
  if (unmetered) return unmetered.guaranteed_concurrency
  const [entitlement] = await input.tx
    .select({ limit: plans.max_concurrent_tasks })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.plan_id, plans.id))
    .where(
      and(
        eq(subscriptions.user_id, input.userId),
        eq(subscriptions.status, 'active'),
        lte(subscriptions.starts_at, input.now),
        gt(subscriptions.ends_at, input.now),
      ),
    )
    .limit(1)
  return entitlement?.limit ?? 1
}

export async function accountConcurrencyEntitlement(
  input: Parameters<NonNullable<PrivateTaskHooks['accountConcurrencyEntitlement']>>[0],
): Promise<{ guaranteed: number; idle: number }> {
  if (!isCapabilityEnabled('billing:credits')) return { guaranteed: 3, idle: 3 }
  const unmetered = await unmeteredEntitlement(input.tx, input.userId)
  if (unmetered)
    return { guaranteed: unmetered.guaranteed_concurrency, idle: unmetered.idle_concurrency }
  const [entitlement] = await input.tx
    .select({ guaranteed: plans.max_concurrent_tasks, idle: plans.idle_concurrent_tasks })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.plan_id, plans.id))
    .where(
      and(
        eq(subscriptions.user_id, input.userId),
        eq(subscriptions.status, 'active'),
        lte(subscriptions.starts_at, input.now),
        gt(subscriptions.ends_at, input.now),
      ),
    )
    .limit(1)
  // 没有有效订阅：保证 1、不给弹性名额。
  if (!entitlement) return { guaranteed: 1, idle: 1 }
  return {
    guaranteed: entitlement.guaranteed,
    idle: Math.max(entitlement.guaranteed, entitlement.idle ?? entitlement.guaranteed),
  }
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
