import { randomUUID } from 'node:crypto'
import { creditsFor } from './calculations'

export type LedgerBucket = 'subscription' | 'recharge'
export type LedgerType =
  | 'grant'
  | 'recharge'
  | 'hold'
  | 'commit'
  | 'release'
  | 'expire'
  | 'adjustment'

export function ledgerRow(input: {
  userId: string
  bucket: LedgerBucket
  type: LedgerType
  amount: number
  now: number
  taskId?: string
  referenceId?: string
  model?: string
  quantity?: number
  operatorId?: string
  note?: string
  metadata?: Record<string, unknown>
}) {
  return {
    id: randomUUID(),
    user_id: input.userId,
    bucket: input.bucket,
    entry_type: input.type,
    amount: input.amount,
    task_id: input.taskId ?? null,
    reference_id: input.referenceId ?? null,
    model: input.model ?? null,
    quantity: input.quantity ?? null,
    operator_id: input.operatorId ?? null,
    note: input.note ?? null,
    metadata: input.metadata ?? {},
    created_at: input.now,
  }
}

/**
 * 套餐积分只在原发放期内退得回去：期已过、或账户已经换到下一期，退回去就是凭空多给一个月的额度。
 * 结算与回填必须用同一条判据，否则两条路径对同一笔 hold 会给出不同的余额。
 */
export function refundableSubscriptionAmount(input: {
  subscriptionAmount: number
  holdExpiresAt: number | null
  accountExpiresAt: number | null
  now: number
}): number {
  const withinOriginalPeriod =
    input.subscriptionAmount > 0 &&
    input.holdExpiresAt !== null &&
    input.holdExpiresAt > input.now &&
    input.accountExpiresAt === input.holdExpiresAt
  return withinOriginalPeriod ? input.subscriptionAmount : 0
}

/** 算不出用量时按预留额全额结算——退错方向就是凭空造出积分。 */
export function settledAmount(input: {
  creditsPerUnit: number
  quantity: number
  unitMultiplier: number
  reservedAmount: number
}): number {
  const actual = creditsFor(input)
  if (!Number.isFinite(actual) || actual < 0) return input.reservedAmount
  return Math.min(actual, input.reservedAmount)
}

/** 结算额按预扣时同一条「套餐桶优先」的顺序分摊，各桶多预扣的部分退回本桶。 */
export function partialRefund(input: {
  settled: number
  subscriptionHeld: number
  rechargeHeld: number
}): { subscriptionRefund: number; rechargeRefund: number } {
  const fromSubscription = Math.min(input.settled, input.subscriptionHeld)
  return {
    subscriptionRefund: input.subscriptionHeld - fromSubscription,
    rechargeRefund: input.rechargeHeld - (input.settled - fromSubscription),
  }
}
