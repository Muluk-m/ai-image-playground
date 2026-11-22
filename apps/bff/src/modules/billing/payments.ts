import { createHash } from 'node:crypto'
import type { BillingTransaction } from '@image-playground/db/billing'
import { confirmedPayments } from '@image-playground/db/billing'
import type { ConfirmedPaymentInput } from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { applyPaymentReferral } from './referrals'

export async function beginConfirmedPayment(
  tx: BillingTransaction,
  input: {
    userId: string
    kind: 'recharge' | 'subscription'
    payment: ConfirmedPaymentInput | null
    details: Record<string, unknown>
    operatorId: string
    now: number
  },
) {
  const payment = input.payment
  if (payment === null) return null
  if (
    !payment ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payment.operation_id) ||
    !Number.isSafeInteger(payment.amount_cents) ||
    payment.amount_cents <= 0 ||
    payment.amount_cents > MAX_CREDIT_BALANCE
  ) {
    throw new Error('invalid_payment')
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify([input.userId, input.kind, payment.amount_cents, input.details]))
    .digest('hex')
  const [created] = await tx
    .insert(confirmedPayments)
    .values({
      id: payment.operation_id,
      user_id: input.userId,
      kind: input.kind,
      amount_cents: payment.amount_cents,
      request_hash: requestHash,
      operator_id: input.operatorId,
      created_at: input.now,
    })
    .onConflictDoNothing()
    .returning()
  if (created) return { record: await applyPaymentReferral(tx, created), replay: false }

  const [existing] = await tx
    .select()
    .from(confirmedPayments)
    .where(eq(confirmedPayments.id, payment.operation_id))
    .limit(1)
  if (!existing || existing.request_hash !== requestHash) throw new Error('payment_conflict')
  return { record: existing, replay: true }
}

export async function getConfirmedPayments(userId: string) {
  const rows = await db
    .select({
      id: confirmedPayments.id,
      user_id: confirmedPayments.user_id,
      kind: confirmedPayments.kind,
      amount_cents: confirmedPayments.amount_cents,
      result: confirmedPayments.result,
      operator_id: confirmedPayments.operator_id,
      created_at: confirmedPayments.created_at,
      inviter_user_id: confirmedPayments.inviter_user_id,
      paid_reward_basis_points: confirmedPayments.paid_reward_basis_points,
      credits_per_yuan_scaled: confirmedPayments.credits_per_yuan_scaled,
      reward_credits: confirmedPayments.reward_credits,
    })
    .from(confirmedPayments)
    .where(eq(confirmedPayments.user_id, userId))
    .orderBy(desc(confirmedPayments.created_at), desc(confirmedPayments.id))
    .limit(100)
  return rows.map(({ credits_per_yuan_scaled, ...row }) => ({
    ...row,
    credits_per_yuan: credits_per_yuan_scaled === null ? null : credits_per_yuan_scaled / 10_000,
  }))
}

export async function isHistoricalPayment(userId: string, id: string) {
  const [payment] = await db
    .select({ id: confirmedPayments.id })
    .from(confirmedPayments)
    .where(and(eq(confirmedPayments.id, id), eq(confirmedPayments.user_id, userId)))
  return Boolean(payment)
}
