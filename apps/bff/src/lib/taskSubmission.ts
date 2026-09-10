import type {
  PersistedSubmitRequest,
  PersistedVideoRequest,
  SubmitRequest,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { isCapabilityEnabled } from './capabilities'
import { archiveInputImages, ObjectStorageError } from './imageArchive'
import { objectStore } from './objectStore'
import { loadPrivateBffOverlay } from './private-overlay'
import { asQueueProvider } from './queueProvider'
import { type QuotaConsumeResult, tryConsumeQuotaInTransaction } from './quota'

/** 计价用量：图片任务是张数，视频任务是秒数，倍率跟着清晰度走。 */
export interface TaskPricing {
  readonly quantity: number
  readonly unitMultiplier: number
}

export interface CreateQueueTaskInput {
  readonly provider: NonNullable<ReturnType<typeof asQueueProvider>>
  readonly model: string
  /** 输入图仍是 data URL，落库前在这里归档进对象存储。 */
  readonly request: Omit<SubmitRequest, 'video'>
  readonly video?: PersistedVideoRequest
  readonly userId: string | null
  readonly pricing: TaskPricing
  /** 免费部署的每日配额计数单位：一条视频算一次，图片按张数。 */
  readonly quotaUnits: number
  /** 智能体工具提交时带上会话与轮，任务由此可反查属于哪一轮。 */
  readonly agent?: { readonly conversationId: string; readonly turnId: string }
}

export type CreateQueueTaskOutcome =
  | { readonly kind: 'created'; readonly taskId: string; readonly submittedAt: number }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'authentication_required' }
  | { readonly kind: 'insufficient_credits'; readonly required: number; readonly available: number }
  | { readonly kind: 'price_unavailable'; readonly model: string }
  | { readonly kind: 'quota_exceeded'; readonly quota: QuotaConsumeResult }
  | { readonly kind: 'invalid_input_image'; readonly message: string }
  | { readonly kind: 'object_storage_error'; readonly message: string }

export async function findTaskByIdempotencyKey(clientRequestId: string, userId: string | null) {
  const ownerCondition = userId ? eq(schema.tasks.user_id, userId) : isNull(schema.tasks.user_id)
  const [task] = await db
    .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.client_request_id, clientRequestId), ownerCondition))
    .limit(1)
  return task
}

/**
 * 落一条队列任务：归档输入图、插行、在同一事务里预扣积分或每日配额。
 * 提交路由与智能体工具共用这一条路径，计费与配额的语义因此只有一份。
 */
export async function createQueueTask(
  input: CreateQueueTaskInput,
): Promise<CreateQueueTaskOutcome> {
  const id = crypto.randomUUID()
  let requestPayload: PersistedSubmitRequest
  try {
    requestPayload = {
      ...(await archiveInputImages(id, input.request)),
      ...(input.video ? { video: input.video } : {}),
    }
  } catch (error) {
    await discardArchivedInputs(id)
    if (error instanceof TypeError) {
      return { kind: 'invalid_input_image', message: error.message }
    }
    return {
      kind: 'object_storage_error',
      message:
        error instanceof ObjectStorageError ? error.message : 'Object storage input archive failed',
    }
  }

  const now = Date.now()
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const dailyQuotaEnabled = isCapabilityEnabled('quota:daily')
  const dailyImageQuota = config.operator.quotas['generation:daily-images']
  const outcome = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.tasks)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        status: 'queued',
        request_payload: requestPayload,
        submitted_at: now,
        user_id: input.userId,
        client_request_id: input.request.client_request_id ?? null,
        agent_conversation_id: input.agent?.conversationId ?? null,
        agent_turn_id: input.agent?.turnId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

    if (inserted.length === 0) return { kind: 'idempotency_conflict' as const }

    if (isCapabilityEnabled('billing:credits')) {
      if (!input.userId) {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return { kind: 'authentication_required' as const }
      }
      const reservation = await taskHooks.reserveTask({
        tx,
        taskId: id,
        userId: input.userId,
        model: input.model,
        quantity: input.pricing.quantity,
        unitMultiplier: input.pricing.unitMultiplier,
      })
      if (reservation.kind !== 'reserved') {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return reservation
      }
    } else if (dailyQuotaEnabled) {
      const quota = await tryConsumeQuotaInTransaction(
        tx,
        input.request.device_id ?? '',
        input.quotaUnits,
        dailyImageQuota,
      )
      if (!quota.ok) {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return { kind: 'quota_exceeded' as const, quota }
      }
    }
    return {
      kind: 'created' as const,
      taskId: inserted[0]!.id,
      submittedAt: inserted[0]!.submitted_at,
    }
  })

  if (outcome.kind !== 'created') await discardArchivedInputs(id)
  return outcome
}

/** 没有任务行引用这个前缀了；删不掉也只是留个孤儿，由 bucket lifecycle 收。 */
async function discardArchivedInputs(taskId: string): Promise<void> {
  try {
    await objectStore().deletePrefix(`${taskId}/in/`)
  } catch {
    // Bucket lifecycle cleanup removes any orphan.
  }
}
