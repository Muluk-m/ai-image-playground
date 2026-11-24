import { randomUUID } from 'node:crypto'
import {
  billingSettings,
  confirmedPayments,
  creditAccounts,
  creditLedger,
  planPrices,
  plans,
  subscriptions,
} from '@image-playground/db/billing'
import { type ConfirmedPaymentInput, MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import type { BffTransaction } from '../../lib/billing-hooks'
import { lockAccount } from './accounts'
import { addCalendarMonths } from './calculations'
import {
  expireSubscriptionBalance,
  grantMonthlyCredits,
  planById,
  reconcileAccount,
  unmeteredEntitlement,
} from './entitlement'
import { beginConfirmedPayment } from './payments'
import { ledgerRow } from './settlement'

const OPERATOR_ID = 'admin'

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
  tx: BffTransaction,
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
