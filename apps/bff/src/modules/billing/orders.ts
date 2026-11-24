import { randomInt, randomUUID } from 'node:crypto'
import {
  accountFacts,
  billingSettings,
  orderRequestAliases,
  planPrices,
  plans,
  purchaseOrders,
  subscriptions,
} from '@image-playground/db/billing'
import type { BillingPeriodMonths, PurchaseOrder } from '@image-playground/shared'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import { hasCreditAccount } from './accounts'
import { addCalendarMonths, effectivePrice } from './calculations'
import { grantSubscriptionInTransaction } from './commerce'
import { rechargeAmountsYuan, rechargeCreditsPerYuan } from './config'
import { unmeteredEntitlement } from './entitlement'
import { adjustRechargeCreditsInTransaction } from './ledger'

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const shortCode = () =>
  Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
type OrderRow = typeof purchaseOrders.$inferSelect
export class OrderError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(code)
  }
}
async function settings() {
  const [row] = await db.select().from(billingSettings).where(eq(billingSettings.id, 'default'))
  return row
}
async function presentOrderWithSettings(
  row: OrderRow,
  config: Awaited<ReturnType<typeof settings>>,
): Promise<PurchaseOrder> {
  return {
    id: row.id,
    code: row.code,
    user_id: row.user_id,
    kind: row.kind,
    recharge_credits: row.recharge_credits,
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    period_months: row.period_months as BillingPeriodMonths,
    amount_cents: row.amount_cents,
    status: row.status === 'pending' && row.expires_at <= Date.now() ? 'expired' : row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    ends_at: row.ends_at,
    review_note: row.status === 'rejected' ? row.rejection_message : '',
    payment_code: row.payment_code,
    payment_history: row.payment_history,
    payment_available: Boolean(
      config?.payments_enabled && config.payment_code_id === row.payment_code.id,
    ),
    subscription_action: row.subscription_action,
    contact_qr_url: config?.contact_qr_url ?? '',
    contact_wechat: config?.contact_wechat ?? '',
    notification_status: row.notification_status,
  }
}
export class OpenOrderConflict extends OrderError {
  constructor(readonly order: PurchaseOrder) {
    super('open_order_exists')
  }
}

export async function presentOrder(row: OrderRow): Promise<PurchaseOrder> {
  return presentOrderWithSettings(row, await settings())
}
export async function getOrder(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.user_id, userId)))
  if (!row) throw new OrderError('order_not_found', 404)
  return presentOrder(row)
}
export async function listOrders(userId: string) {
  const rows = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.user_id, userId))
    .orderBy(desc(purchaseOrders.created_at))
    .limit(50)
  const config = await settings()
  return Promise.all(rows.map((row) => presentOrderWithSettings(row, config)))
}
export async function createOrder(
  userId: string,
  input:
    | {
        kind?: 'subscription'
        plan_id: string
        period_months: BillingPeriodMonths
        request_id: string
      }
    | { kind: 'recharge'; amount_cents: number; request_id: string },
) {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-create:${userId}`}))`)
    const [enterprise] = await tx
      .select({ userId: accountFacts.user_id })
      .from(accountFacts)
      .where(eq(accountFacts.user_id, userId))
      .for('share')
      .limit(1)
    const billingUnavailable =
      Boolean(await unmeteredEntitlement(tx, userId)) ||
      (Boolean(enterprise) && !(await hasCreditAccount(tx, userId)))
    let [existing] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(eq(purchaseOrders.user_id, userId), eq(purchaseOrders.request_id, input.request_id)),
      )
    if (!existing) {
      const [alias] = await tx
        .select({ order: purchaseOrders })
        .from(orderRequestAliases)
        .innerJoin(purchaseOrders, eq(orderRequestAliases.order_id, purchaseOrders.id))
        .where(
          and(
            eq(orderRequestAliases.user_id, userId),
            eq(orderRequestAliases.request_id, input.request_id),
          ),
        )
      existing = alias?.order
    }
    if (billingUnavailable && (!existing || existing.status !== 'completed'))
      throw new OrderError('billing_account_unavailable', 403)
    if (existing) {
      if (
        existing.kind !== (input.kind ?? 'subscription') ||
        (input.kind === 'recharge'
          ? existing.amount_cents !== input.amount_cents
          : existing.plan_id !== input.plan_id || existing.period_months !== input.period_months)
      )
        throw new OrderError('order_request_conflict')
      return existing
    }
    const now = Date.now()
    const [config] = await tx
      .select()
      .from(billingSettings)
      .where(eq(billingSettings.id, 'default'))
      .for('share')
    const [open] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.user_id, userId),
          sql`(${purchaseOrders.status} = 'review' OR (${purchaseOrders.status} = 'pending' AND ${purchaseOrders.expires_at} > ${new Date(now)}))`,
        ),
      )
      .limit(1)
    if (open) {
      const samePurchase =
        open.kind === (input.kind ?? 'subscription') &&
        (input.kind === 'recharge'
          ? open.amount_cents === input.amount_cents
          : open.plan_id === input.plan_id && open.period_months === input.period_months)
      if (samePurchase) {
        await tx
          .insert(orderRequestAliases)
          .values({ user_id: userId, request_id: input.request_id, order_id: open.id })
        return open
      }
      throw new OpenOrderConflict(await presentOrderWithSettings(open, config))
    }
    if (
      !config?.payments_enabled ||
      !config.payment_qr_url ||
      !config.receiving_account ||
      !config.payment_code_id
    )
      throw new OrderError('payments_unavailable')
    let amount: number
    let subscriptionAction: 'grant' | 'renew' | 'upgrade' | 'schedule' | null = null
    let product: {
      kind: 'subscription' | 'recharge'
      plan_id: string | null
      plan_name: string | null
      period_months: number | null
      recharge_credits: number | null
    }
    if (input.kind === 'recharge') {
      amount = input.amount_cents
      if (
        !Number.isSafeInteger(amount) ||
        amount < 100 ||
        amount % 100 !== 0 ||
        !rechargeAmountsYuan.includes(amount / 100)
      )
        throw new OrderError('invalid_recharge_amount', 400)
      product = {
        kind: 'recharge',
        plan_id: null,
        plan_name: null,
        period_months: null,
        recharge_credits: (amount / 100) * rechargeCreditsPerYuan,
      }
    } else {
      const [plan] = await tx.select().from(plans).where(eq(plans.id, input.plan_id)).for('share')
      if (!plan?.active) throw new OrderError('plan_unavailable')
      const [current] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.user_id, userId),
            eq(subscriptions.status, 'active'),
            gt(subscriptions.ends_at, now),
          ),
        )
      if (!current) subscriptionAction = 'grant'
      else if (current.plan_id === plan.id) subscriptionAction = 'renew'
      else if (current.scheduled_plan_id) throw new OrderError('scheduled_plan_change_exists')
      else {
        const [currentPlan] = await tx
          .select()
          .from(plans)
          .where(eq(plans.id, current.plan_id))
          .for('share')
        subscriptionAction =
          currentPlan && plan.monthly_credits > currentPlan.monthly_credits ? 'upgrade' : 'schedule'
      }
      const [price] = await tx
        .select()
        .from(planPrices)
        .where(
          and(eq(planPrices.plan_id, plan.id), eq(planPrices.period_months, input.period_months)),
        )
        .for('share')
      if (!price) throw new OrderError('price_unavailable')
      amount = effectivePrice(
        price.original_price_cents,
        price.discount_price_cents,
        price.discount_ends_at,
        now,
      )
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 100 !== 0)
        throw new OrderError('price_unavailable')
      product = {
        kind: 'subscription',
        plan_id: plan.id,
        plan_name: plan.name,
        period_months: input.period_months,
        recharge_credits: null,
      }
    }
    const codeVersion = {
      id: config.payment_code_id,
      channel: config.payment_channel,
      account: config.receiving_account,
      url: config.payment_qr_url,
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const [created] = await tx
        .insert(purchaseOrders)
        .values({
          id: randomUUID(),
          code: shortCode(),
          request_id: input.request_id,
          user_id: userId,
          ...product,
          subscription_action: subscriptionAction,
          amount_cents: amount,
          status: 'pending',
          created_at: now,
          expires_at: now + 30 * 60_000,
          payment_code: codeVersion,
          payment_history: [{ ...codeVersion, shown_at: now }],
          notification_status: 'pending',
        })
        .onConflictDoNothing({ target: purchaseOrders.code })
        .returning()
      if (created) return created
    }
    throw new Error('order_code_exhausted')
  })
  return presentOrder(row)
}

export class ReceiptConflict extends OrderError {
  constructor(public orderId: string) {
    super('receipt_already_used')
  }
}
export async function confirmOrder(
  id: string,
  receipt: import('@image-playground/shared').OrderConfirmation,
  operatorId: string,
) {
  const row = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .for('update')
    if (!order) throw new OrderError('order_not_found', 404)
    const now = Date.now()
    const normalized: import('@image-playground/shared').OrderReceipt = {
      ...receipt,
      receiving_account: receipt.receiving_account.trim(),
      transaction_id: receipt.transaction_id?.trim() || null,
      received_at: receipt.received_at ?? now,
      ...(receipt.received_at === undefined ? { received_at_source: 'confirmation' as const } : {}),
      note: receipt.note.trim(),
    }
    if (
      !normalized.receiving_account ||
      !Number.isSafeInteger(normalized.received_at) ||
      normalized.received_at > now
    )
      throw new OrderError('invalid_receipt', 400)
    const version = order.payment_history.find((v) => v.id === receipt.payment_code_id)
    if (
      !version ||
      version.channel !== receipt.channel ||
      version.account !== normalized.receiving_account
    )
      throw new OrderError('receipt_account_mismatch')
    if (order.amount_cents !== receipt.amount_cents) throw new OrderError('receipt_amount_mismatch')
    // Only provider-issued transaction IDs deduplicate across orders. Manual confirmations
    // remain idempotent under the order row lock and never invent a provider transaction ID.
    if (normalized.transaction_id) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${JSON.stringify([receipt.channel, normalized.receiving_account, normalized.transaction_id])}))`,
      )
      const [used] = await tx
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.receipt_channel, receipt.channel),
            eq(purchaseOrders.receipt_account, normalized.receiving_account),
            eq(purchaseOrders.receipt_transaction, normalized.transaction_id),
          ),
        )
      if (used && used.id !== id) throw new ReceiptConflict(used.id)
    }
    if (order.status === 'completed') {
      if (
        order.receipt_transaction !== normalized.transaction_id ||
        order.receipt_channel !== normalized.channel ||
        order.receipt_account !== normalized.receiving_account
      )
        throw new OrderError('receipt_conflict')
      return order
    }
    if (normalized.received_at < order.created_at - 60_000)
      throw new OrderError('invalid_receipt', 400)
    if (
      !['pending', 'review'].includes(order.status) ||
      (order.status === 'pending' && order.expires_at <= Date.now())
    )
      throw new OrderError('order_requires_reopen')
    if (
      receipt.received_at !== undefined &&
      receipt.received_at > order.expires_at &&
      !order.history.some((h) => h.action === 'reopen')
    )
      throw new OrderError('late_payment_requires_reopen')
    let startsAt: number | null = null
    let endsAt: number | null = null
    // Payment/referral locks precede the payer account lock inside fulfilment.
    const payment = { operation_id: order.id, amount_cents: order.amount_cents }
    let subscriptionAction = order.subscription_action
    const [enterprise] = await tx
      .select({ userId: accountFacts.user_id })
      .from(accountFacts)
      .where(eq(accountFacts.user_id, order.user_id))
      .for('share')
      .limit(1)
    if (
      (await unmeteredEntitlement(tx, order.user_id)) ||
      (enterprise && !(await hasCreditAccount(tx, order.user_id)))
    )
      throw new OrderError('billing_account_unavailable', 403)
    if (order.kind === 'recharge') {
      if (!order.recharge_credits) throw new Error('invalid_recharge_order')
      await adjustRechargeCreditsInTransaction(tx, {
        userId: order.user_id,
        amount: order.recharge_credits,
        reason: `order:${order.id}`,
        payment,
        operatorId,
      })
    } else {
      if (!order.plan_id || !order.period_months) throw new Error('invalid_subscription_order')
      startsAt = order.starts_at ?? now
      let result: Awaited<ReturnType<typeof grantSubscriptionInTransaction>>
      try {
        result = await grantSubscriptionInTransaction(
          tx,
          {
            userId: order.user_id,
            planId: order.plan_id,
            periodMonths: order.period_months as BillingPeriodMonths,
            startsAt,
            reason: `order:${order.id}`,
            payment,
            operatorId,
            scheduleOrderId: order.id,
          },
          true,
        )
      } catch (error) {
        if (error instanceof Error && error.message === 'scheduled_plan_change_exists') {
          throw new OrderError('scheduled_plan_change_exists')
        }
        throw error
      }
      endsAt = result.ends_at ?? null
      if ((result.action === 'schedule' || result.action === 'upgrade') && result.effective_at)
        startsAt = result.effective_at
      // 换档结果里的 ends_at 是旧档到期时间；订单记的是买到的这一段：生效起、按购买月数止。
      if (result.action === 'schedule' && result.effective_at)
        endsAt = addCalendarMonths(result.effective_at, order.period_months)
      if (result.action) subscriptionAction = result.action
    }
    const [completed] = await tx
      .update(purchaseOrders)
      .set({
        status: 'completed',
        receipt: normalized,
        receipt_channel: normalized.channel,
        receipt_account: normalized.receiving_account,
        receipt_transaction: normalized.transaction_id,
        starts_at: startsAt,
        ends_at: endsAt,
        subscription_action: subscriptionAction,
        completed_at: now,
        review_note: normalized.note,
        history: [
          ...order.history,
          { action: 'confirm', operator_id: operatorId, note: normalized.note, at: now },
        ],
      })
      .where(eq(purchaseOrders.id, id))
      .returning()
    if (!completed) throw new Error('order_missing')
    return completed
  })
  return presentOrder(row)
}

export async function userOrderAction(
  userId: string,
  id: string,
  action: 'claim' | 'cancel' | 'refresh-code',
) {
  const row = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.user_id, userId)))
      .for('update')
    if (!order) throw new OrderError('order_not_found', 404)
    if (action === 'claim' && ['review', 'completed'].includes(order.status)) return order
    if (action === 'cancel' && order.status === 'cancelled') return order
    if (order.status !== 'pending' || order.expires_at <= Date.now())
      throw new OrderError('order_not_payable')
    const now = Date.now()
    if (action === 'refresh-code') {
      const [config] = await tx
        .select()
        .from(billingSettings)
        .where(eq(billingSettings.id, 'default'))
        .for('share')
      if (!config?.payments_enabled || !config.payment_code_id || !config.receiving_account)
        throw new OrderError('payments_unavailable')
      const code = {
        id: config.payment_code_id,
        channel: config.payment_channel,
        account: config.receiving_account,
        url: config.payment_qr_url,
      }
      if (order.payment_code.id === code.id) return order
      const [changed] = await tx
        .update(purchaseOrders)
        .set({
          payment_code: code,
          payment_history: [...order.payment_history, { ...code, shown_at: now }],
        })
        .where(eq(purchaseOrders.id, id))
        .returning()
      return changed!
    }
    const [changed] = await tx
      .update(purchaseOrders)
      .set({
        status: action === 'claim' ? 'review' : 'cancelled',
        claimed_at: action === 'claim' ? now : order.claimed_at,
      })
      .where(eq(purchaseOrders.id, id))
      .returning()
    return changed!
  })
  return presentOrder(row)
}

export async function adminOrder(id: string) {
  const [row] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id))
  if (!row) throw new OrderError('order_not_found', 404)
  const [user] = await db
    .select({ username: publicSchema.users.username })
    .from(publicSchema.users)
    .where(eq(publicSchema.users.id, row.user_id))
  return {
    ...(await presentOrder(row)),
    username: user?.username ?? row.user_id,
    review_note: row.review_note,
    receipt: row.receipt,
    history: row.history,
  }
}
export async function findOrders(query: {
  q?: string
  amount_cents?: number
  received_at?: number
  user_id?: string
  state?: 'open'
}) {
  const q = query.q?.trim()
  const rows = await db
    .select({ order: purchaseOrders, username: publicSchema.users.username })
    .from(purchaseOrders)
    .leftJoin(publicSchema.users, eq(publicSchema.users.id, purchaseOrders.user_id))
    .where(
      and(
        q
          ? sql`(${purchaseOrders.code} = ${q.toUpperCase()} OR ${purchaseOrders.id} = ${q})`
          : undefined,
        query.state === 'open'
          ? sql`(${purchaseOrders.status} = 'review' OR (${purchaseOrders.status} = 'pending' AND ${purchaseOrders.expires_at} > ${new Date()}))`
          : undefined,
        query.user_id ? eq(purchaseOrders.user_id, query.user_id) : undefined,
        query.amount_cents === undefined
          ? undefined
          : eq(purchaseOrders.amount_cents, query.amount_cents),
        query.received_at === undefined
          ? undefined
          : sql`${purchaseOrders.created_at} <= ${new Date(query.received_at + 60_000)} AND ${purchaseOrders.expires_at} >= ${new Date(query.received_at - 86400_000)}`,
      ),
    )
    .orderBy(desc(purchaseOrders.created_at))
    .limit(100)
  const config = await settings()
  return {
    orders: await Promise.all(
      rows.map(async ({ order, username }) => ({
        ...(await presentOrderWithSettings(order, config)),
        username: username ?? order.user_id,
        review_note: order.review_note,
        receipt: order.receipt,
        history: order.history,
      })),
    ),
  }
}
export async function reviewOrder(
  id: string,
  action: 'note' | 'reject' | 'reopen',
  note: string,
  operatorId: string,
  rejectionMessage = '',
) {
  if (action === 'reject' && !rejectionMessage.trim())
    throw new OrderError('rejection_message_required', 400)
  if (!note.trim()) throw new OrderError('reason_required', 400)
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .for('update')
    if (!order) throw new OrderError('order_not_found', 404)
    if (order.status === 'completed' && action !== 'note') throw new OrderError('order_completed')
    if (action === 'reject' && order.status !== 'review')
      throw new OrderError('order_not_in_review')
    if (action === 'reopen' && order.status === 'pending' && order.expires_at > Date.now())
      throw new OrderError('order_not_closed')
    const now = Date.now()
    await tx
      .update(purchaseOrders)
      .set({
        status: action === 'reject' ? 'rejected' : action === 'reopen' ? 'review' : order.status,
        review_note: note.trim(),
        ...(action === 'reject' ? { rejection_message: rejectionMessage.trim() } : {}),
        history: [
          ...order.history,
          { action, operator_id: operatorId, note: note.trim(), at: now },
        ],
      })
      .where(eq(purchaseOrders.id, id))
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: `billing.order.${action}`,
      target_type: 'order',
      target_id: id,
      details: { note: note.trim() },
      created_at: now,
    })
  })
  return adminOrder(id)
}
