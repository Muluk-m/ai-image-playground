import type { AgentBatchPriceSnapshot, ImageTierSnapshot } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { config } from '../../config'
import { schema } from '../../db/client'
import { type BffTransaction, loadMeteringPort, type MeteringPort } from '../../lib/billing-ports'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { meteringDecisionOrDenied } from '../../lib/metering-decision'
import { modelUnavailable } from '../../lib/model-availability'
import { tryConsumeQuotaInTransaction } from '../../lib/quota'
import {
  type ImageTierAlignment,
  premiumRequestAllowed,
  premiumTierRequested,
  strictImageRequestAllowed,
  tierSnapshot,
} from './submission-tier'
import type {
  CreateQueueTaskInput,
  CreateQueueTaskOutcome,
  TaskPricingUnits,
} from './task-submission-plugins'

export class MaxCreditsExceeded extends Error {
  constructor(
    readonly required: number,
    readonly maxCredits: number,
  ) {
    super('max_credits_exceeded')
  }
}

export interface TaskMeteringRecord {
  readonly mode: 'credits' | 'none'
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
  readonly pricing?: AgentBatchPriceSnapshot
  readonly tier?: ImageTierSnapshot
}

export type AdmissionCheckResult =
  | {
      readonly kind: 'allowed'
      readonly metering: TaskMeteringRecord
      readonly unmeteredByDecision: boolean
    }
  | { readonly kind: 'refused'; readonly outcome: CreateQueueTaskOutcome }

export type ReservationCheckResult =
  | { readonly kind: 'reserved'; readonly reservedCredits: number }
  | { readonly kind: 'refused'; readonly outcome: CreateQueueTaskOutcome }

export function loadSubmissionTaskHooks(): Promise<MeteringPort> {
  return loadMeteringPort()
}

/**
 * 提交事务内的访问门禁：模型可用性与 4K/严格档位会员资格。
 */
export async function checkSubmissionAccessGates(
  tx: BffTransaction,
  input: CreateQueueTaskInput,
  aligned: ImageTierAlignment,
): Promise<CreateQueueTaskOutcome | null> {
  if (await modelUnavailable(tx, input.model)) {
    return { kind: 'price_unavailable', model: input.model }
  }
  if (input.strictImageRequest) {
    if (!input.userId) return { kind: 'authentication_required' }
    if (
      !(await strictImageRequestAllowed(
        tx,
        input.userId,
        input.provider,
        input.model,
        input.request,
      ))
    )
      return { kind: 'private_billing_denied' }
  } else if (
    aligned.decision
      ? aligned.decision.requires.membership
      : premiumTierRequested(input.provider, input.request)
  ) {
    if (!input.userId) return { kind: 'authentication_required' }
    if (!(await premiumRequestAllowed(tx, input.userId, input.model, input.request)))
      return { kind: 'private_billing_denied' }
  }
  return null
}

/**
 * 提交事务内的计费模式判定与 maxCredits 预报价（在连点去重之后、插入 `tasks` 之前）。
 */
export async function resolveSubmissionMetering(
  tx: BffTransaction,
  input: CreateQueueTaskInput,
  aligned: ImageTierAlignment,
  pricing: TaskPricingUnits,
  taskHooks: MeteringPort,
): Promise<AdmissionCheckResult> {
  let metering: TaskMeteringRecord = {
    mode: isCapabilityEnabled('billing:credits') ? 'credits' : 'none',
    model: input.model,
    quantity: pricing.quantity,
    unitMultiplier: pricing.unitMultiplier,
    ...(aligned.decision
      ? { tier: tierSnapshot(input.entry, aligned.member, aligned.decision) }
      : {}),
  }
  let unmeteredByDecision = false
  if (input.userId) {
    const decision = meteringDecisionOrDenied(
      await taskHooks.meteringDecision?.({
        tx,
        userId: input.userId,
        model: input.model,
        kind: input.video ? 'video' : 'image',
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      }),
      taskHooks.consumeUnmeteredQuota,
    )
    if (decision?.kind === 'denied')
      return { kind: 'refused', outcome: { kind: 'metering_denied', reason: decision.reason } }
    if (decision?.kind === 'unmetered') {
      unmeteredByDecision = true
      metering = { ...metering, mode: 'none' }
    }
    if (decision?.kind === 'metered' && isCapabilityEnabled('billing:credits'))
      metering = {
        ...metering,
        mode: 'credits',
        ...(decision.pricing ? { pricing: decision.pricing } : {}),
      }
  }
  if (input.maxCredits !== undefined && metering.mode === 'credits') {
    const quote = await taskHooks.quoteTask?.({
      tx,
      userId: input.userId ?? '',
      model: input.model,
      quantity: pricing.quantity,
      unitMultiplier: pricing.unitMultiplier,
    })
    if (!quote)
      return { kind: 'refused', outcome: { kind: 'price_unavailable', model: input.model } }
    if (quote.estimatedCredits > input.maxCredits)
      return {
        kind: 'refused',
        outcome: {
          kind: 'max_credits_exceeded',
          required: quote.estimatedCredits,
          maxCredits: input.maxCredits,
        },
      }
  }
  return { kind: 'allowed', metering, unmeteredByDecision }
}

/**
 * 插入 `tasks` 行后执行积分预扣、免计费配额或每日设备配额扣减；被拒时删除刚插入的 task 行，
 * 超出 `maxCredits` 时抛出 `MaxCreditsExceeded` 触发整笔事务回滚。
 */
export async function reserveSubmissionBillingOrQuota(
  tx: BffTransaction,
  params: {
    readonly taskId: string
    readonly input: CreateQueueTaskInput
    readonly pricing: TaskPricingUnits
    readonly metering: TaskMeteringRecord
    readonly unmeteredByDecision: boolean
    readonly taskHooks: MeteringPort
    readonly dailyQuotaEnabled: boolean
    readonly dailyImageQuota: number
  },
): Promise<ReservationCheckResult> {
  const { taskId, input, pricing, metering, unmeteredByDecision, taskHooks } = params
  if (metering.mode === 'credits') {
    if (!input.userId) {
      await tx.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
      return { kind: 'refused', outcome: { kind: 'authentication_required' } }
    }
    const reservation = await taskHooks.reserveTask({
      tx,
      taskId,
      userId: input.userId,
      model: input.model,
      quantity: pricing.quantity,
      unitMultiplier: pricing.unitMultiplier,
    })
    if (reservation.kind !== 'reserved') {
      await tx.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
      if (reservation.kind === 'access_denied')
        return { kind: 'refused', outcome: { kind: 'metering_denied', reason: reservation.reason } }
      if (reservation.kind === 'quota_exceeded')
        return {
          kind: 'refused',
          outcome: {
            kind: 'quota_exceeded',
            quota: {
              ok: false,
              count: reservation.used,
              quota: reservation.quota,
              reset_at: reservation.resetAt,
            },
          },
        }
      return { kind: 'refused', outcome: reservation }
    }
    // 报价与预扣同在这个事务里，正常应一致；预扣按自己的规则算出更多时以它为准，
    // 抛出去让整个事务回滚，任务与预扣一起撤销。
    if (input.maxCredits !== undefined && reservation.credits > input.maxCredits)
      throw new MaxCreditsExceeded(reservation.credits, input.maxCredits)
    return { kind: 'reserved', reservedCredits: reservation.credits }
  }
  if (unmeteredByDecision && input.userId && taskHooks.consumeUnmeteredQuota) {
    const quota = await taskHooks.consumeUnmeteredQuota({
      tx,
      userId: input.userId,
      model: input.model,
      kind: input.video ? 'video' : 'image',
      quantity: pricing.quantity,
      unitMultiplier: pricing.unitMultiplier,
    })
    if (quota.kind === 'quota_exceeded') {
      await tx.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
      return {
        kind: 'refused',
        outcome: {
          kind: 'quota_exceeded',
          quota: {
            ok: false,
            count: quota.used,
            quota: quota.quota,
            reset_at: quota.resetAt,
          },
        },
      }
    }
    return { kind: 'reserved', reservedCredits: 0 }
  }
  if (params.dailyQuotaEnabled) {
    const quota = await tryConsumeQuotaInTransaction(
      tx,
      input.request.device_id ?? '',
      pricing.quotaUnits,
      params.dailyImageQuota,
    )
    if (!quota.ok) {
      await tx.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
      return { kind: 'refused', outcome: { kind: 'quota_exceeded', quota } }
    }
  }
  return { kind: 'reserved', reservedCredits: 0 }
}

export function readDailyQuotaConfig(): {
  readonly dailyQuotaEnabled: boolean
  readonly dailyImageQuota: number
} {
  return {
    dailyQuotaEnabled: isCapabilityEnabled('quota:daily'),
    dailyImageQuota: config.operator.quotas['generation:daily-images'],
  }
}
