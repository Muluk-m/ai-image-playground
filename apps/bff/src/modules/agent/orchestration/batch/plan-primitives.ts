import type {
  AgentBatchEstimates,
  AgentBatchItem,
  AgentBatchPriceSnapshot,
  AgentMediaReference,
} from '@image-playground/shared'
import { preparedImageRateMultiplier } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '../../../../db/client'
import { quoteAnalysisTask } from '../../../../lib/analysis-tasks'
import {
  type BffTransaction,
  loadMeteringPort,
  nonBillingPriceSnapshot,
} from '../../../../lib/billing-ports'
import { isCapabilityEnabled } from '../../../../lib/capabilities'
import { declaredImageSizes } from '../../../../lib/channels'
import { isActiveMember } from '../../../../lib/gpt-membership'
import { meteringDecisionOrDenied } from '../../../../lib/metering-decision'
import {
  type AgentToolAudience,
  type AgentToolError,
  BATCH_EXECUTION_UNAVAILABLE_MESSAGE,
} from '../../contracts'

export function batchPlansAvailable(audience?: AgentToolAudience): boolean {
  return (
    Boolean(audience?.userId) &&
    isCapabilityEnabled('agent:chat') &&
    isCapabilityEnabled('agent:attachments') &&
    isCapabilityEnabled('agent:batch-plans')
  )
}

/** Reuse only an exact archived selection, never combine a known image with a new mask/action. */
export function sameArchivedReference(
  left: AgentMediaReference,
  right: AgentMediaReference,
): boolean {
  return (
    left.imageId === right.imageId &&
    left.mediaId === right.mediaId &&
    left.name === right.name &&
    left.maskMediaId === right.maskMediaId &&
    left.editAction === right.editAction &&
    (left.regions === undefined
      ? right.regions === undefined
      : right.regions !== undefined &&
        left.regions.length === right.regions.length &&
        left.regions.every((region, index) => {
          const other = right.regions![index]!
          return (
            region.x === other.x &&
            region.y === other.y &&
            region.width === other.width &&
            region.height === other.height
          )
        }))
  )
}

/** 纯文字生图的计划没有输入图，不查也不登记媒体引用（空 values 会让插入直接报错）。 */
export async function readyBatchMedia(
  tx: BffTransaction,
  userId: string,
  mediaIds: readonly string[],
): Promise<readonly { id: string }[]> {
  if (!mediaIds.length) return []
  return tx
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        inArray(schema.media_objects.id, [...mediaIds]),
      ),
    )
}

export async function insertBatchMediaReferences(
  tx: BffTransaction,
  userId: string,
  batchId: string,
  mediaIds: readonly string[],
  now: number,
): Promise<void> {
  if (!mediaIds.length) return
  await tx
    .insert(schema.media_references)
    .values(
      mediaIds.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'batch' as const,
        owner_id: batchId,
        created_at: now,
      })),
    )
    .onConflictDoNothing()
}

export class BatchPlanError extends Error {
  constructor(
    readonly code:
      | AgentToolError['code']
      | 'context_overflow'
      | 'analysis_inputs_invalid'
      | 'analysis_output_budget_invalid'
      | 'analysis_visual_evidence_missing'
      | 'batch_execution_unavailable'
      | 'batch_retry_unavailable'
      | 'batch_analysis_incomplete'
      | 'batch_scope_reduction_required'
      | 'batch_size_exceeded'
      | 'batch_source_limit_exceeded'
      | 'batch_source_version_conflict'
      | 'batch_version_conflict'
      | 'batch_price_changed'
      | 'batch_submission_refused'
      | 'quota_exceeded'
      | 'batch_input_limit'
      | 'batch_insufficient_credits'
      | 'invalid_batch_plan'
      | 'invalid_batch_cursor'
      | 'batch_not_found',
    readonly status: 400 | 404 | 409 | 422 | 429,
  ) {
    super(code === 'batch_execution_unavailable' ? BATCH_EXECUTION_UNAVAILABLE_MESSAGE : code)
  }
}

const emptyEstimate = {
  status: 'available' as const,
  estimatedCredits: 0,
  estimatedChargeCredits: 0,
  snapshots: [],
}

export async function quoteBatchPlan(
  tx: BffTransaction,
  userId: string,
  items: readonly AgentBatchItem[],
): Promise<AgentBatchEstimates> {
  const hooks = await loadMeteringPort()
  const member = items.some(
    (item) => item.kind === 'generation' && item.params.gemini_image_size === '4K',
  )
    ? await isActiveMember(userId)
    : false
  const generationQuotes = new Map<
    string,
    Awaited<ReturnType<NonNullable<typeof hooks.quoteTask>>> | undefined
  >()
  const generationQuote = async (model: string, unitMultiplier: number) => {
    const key = `${model}\0${unitMultiplier}`
    if (generationQuotes.has(key)) return generationQuotes.get(key)
    const decision = meteringDecisionOrDenied(
      await hooks.meteringDecision?.({
        tx,
        userId,
        model,
        kind: 'image',
        quantity: 1,
        unitMultiplier,
      }),
      hooks.consumeUnmeteredQuota,
    )
    if (decision?.kind === 'denied') {
      generationQuotes.set(key, undefined)
      return undefined
    }
    if (decision?.kind === 'unmetered' || !isCapabilityEnabled('billing:credits')) {
      const quote = {
        estimatedCredits: 0,
        pricing: nonBillingPriceSnapshot({ model, kind: 'image', quantity: 1, unitMultiplier }),
      }
      generationQuotes.set(key, quote)
      return quote
    }
    const quote = await hooks.quoteTask?.({ tx, userId, model, quantity: 1, unitMultiplier })
    generationQuotes.set(key, quote)
    return quote
  }
  const quoteKind = async (kind: AgentBatchItem['kind']) => {
    const selected = items.filter((item) => item.kind === kind)
    if (!selected.length) return emptyEstimate
    const snapshots: AgentBatchPriceSnapshot[] = []
    let estimatedCredits = 0
    let estimatedChargeCredits = 0
    for (const item of selected) {
      const quote =
        item.kind === 'analysis'
          ? await quoteAnalysisTask(
              {
                tx,
                userId,
                model: item.params.model,
                estimatedInputTokens: item.params.estimatedInputTokens,
              },
              hooks,
            )
          : await generationQuote(
              item.params.model,
              preparedImageRateMultiplier(
                item.params.model,
                item.params,
                declaredImageSizes(item.params.model),
                member,
              ),
            )
      if (!quote) return { status: 'unavailable' as const, reason: 'price_unavailable' as const }
      estimatedCredits += quote.estimatedCredits
      estimatedChargeCredits += quote.pricing.exemption === 'none' ? quote.estimatedCredits : 0
      snapshots.push({ ...quote.pricing, itemKey: item.key })
    }
    return { status: 'available' as const, estimatedCredits, estimatedChargeCredits, snapshots }
  }
  return { analysis: await quoteKind('analysis'), generation: await quoteKind('generation') }
}
