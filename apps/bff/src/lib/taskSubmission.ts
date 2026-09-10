import type {
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  SubmitRequest,
  TaskStatus,
} from '@image-playground/shared'
import { QUEUE_TIMEOUTS, videoRateMultiplier } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { isCapabilityEnabled } from './capabilities'
import { describeEmptyResult, type ExtractedResult, extractMeta } from './extractImages'
import { archiveInputImages, ObjectStorageError } from './imageArchive'
import { objectStore } from './objectStore'
import { loadPrivateBffOverlay } from './private-overlay'
import { asQueueProvider } from './queueProvider'
import { type QuotaConsumeResult, tryConsumeQuotaInTransaction } from './quota'

export interface CreateQueueTaskInput {
  readonly provider: QueueProvider
  readonly model: string
  /** 输入图仍是 data URL，落库前在这里归档进对象存储。 */
  readonly request: Omit<SubmitRequest, 'video'>
  readonly video?: PersistedVideoRequest
  readonly userId: string | null
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
 * 计价单位数：图片是张数，视频是秒数；倍率跟着清晰度走。
 * 免费部署的每日配额按输出计数，所以一条视频算一次，不按秒数放大。
 */
function pricingOf(input: CreateQueueTaskInput) {
  const n = input.request.n ?? 1
  if (!input.video) return { quantity: n, unitMultiplier: 1, quotaUnits: n }
  return {
    quantity: input.video.duration_seconds,
    unitMultiplier: videoRateMultiplier(input.model, input.video.resolution),
    quotaUnits: 1,
  }
}

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
  const pricing = pricingOf(input)
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
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      })
      if (reservation.kind !== 'reserved') {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return reservation
      }
    } else if (dailyQuotaEnabled) {
      const quota = await tryConsumeQuotaInTransaction(
        tx,
        input.request.device_id ?? '',
        pricing.quotaUnits,
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

/** 队列任务的终态。`extractMeta` 的结果只在 completed 时有意义。 */
export type QueueTaskOutcome =
  | { readonly kind: 'completed'; readonly result: ExtractedResult }
  | { readonly kind: 'failed'; readonly reason: string }

interface Polling {
  readonly intervalMs: number
  readonly budgetMs: number
}

const DEFAULT_POLLING: Polling = { intervalMs: 1_000, budgetMs: QUEUE_TIMEOUTS.POLL_MAX_MS }

let polling = DEFAULT_POLLING

/** 测试注入点；不传恢复真实节奏。 */
export function setQueueTaskPollingForTesting(next?: Partial<Polling>): void {
  polling = next ? { ...DEFAULT_POLLING, ...next } : DEFAULT_POLLING
}

/** 越等越慢：任务刚提交那几秒 worker 还没轮到它，密集查只是空转。 */
function nextInterval(waitedMs: number): number {
  const step = waitedMs < 5_000 ? 1 : waitedMs < 20_000 ? 2 : 5
  return polling.intervalMs * step
}

/**
 * 等一条队列任务跑到终态。进程内轮询任务表，与 worker 的调度轮询各管各的。
 * `onStatus` 每次状态变化报一次，供调用方把进度推给用户。
 */
export async function awaitQueueTask(
  taskId: string,
  options: {
    readonly signal?: AbortSignal
    readonly onStatus?: (status: TaskStatus) => void
  } = {},
): Promise<QueueTaskOutcome> {
  const startedAt = Date.now()
  let announced: TaskStatus | undefined
  while (true) {
    if (options.signal?.aborted) throw new Error('这一轮被中止了')
    const [task] = await db
      .select({
        status: schema.tasks.status,
        provider: schema.tasks.provider,
        result_payload: schema.tasks.result_payload,
        error_message: schema.tasks.error_message,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    if (!task) return { kind: 'failed', reason: '任务丢失了' }

    if (task.status !== announced) {
      announced = task.status
      options.onStatus?.(task.status)
    }
    if (task.status === 'failed') {
      return { kind: 'failed', reason: task.error_message ?? '任务失败' }
    }
    if (task.status === 'cancelled') return { kind: 'failed', reason: '任务被取消了' }
    if (task.status === 'completed') {
      const provider = asQueueProvider(task.provider)
      if (!provider) return { kind: 'failed', reason: `未知的上游：${task.provider}` }
      const result = extractMeta(provider, task.result_payload)
      if (result.images.length === 0) {
        return { kind: 'failed', reason: describeEmptyResult(provider, task.result_payload) }
      }
      return { kind: 'completed', result }
    }

    const waited = Date.now() - startedAt
    if (waited > polling.budgetMs) return { kind: 'failed', reason: '超时未返回' }
    await Bun.sleep(nextInterval(waited))
  }
}
