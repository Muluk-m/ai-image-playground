import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentJobPlan } from '@image-playground/db'
import type {
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  SubmitRequest,
  TaskErrorType,
  TaskStatus,
} from '@image-playground/shared'
import {
  DEFAULT_IMAGE_MODERATION,
  QUEUE_TIMEOUTS,
  videoRateMultiplier,
} from '@image-playground/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { publishGenerations } from '../db/generation-events'
import { prepareMaskedInput } from './agent/masked-input'
import { isCapabilityEnabled } from './capabilities'
import { describeEmptyResult, type ExtractedResult, extractMeta } from './extractImages'
import { archiveInputImages, hydrateInputImages, ObjectStorageError } from './imageArchive'
import { objectStore } from './objectStore'
import { loadPrivateBffOverlay } from './private-overlay'
import { reserveProjectOutputs } from './projectArchive'
import { lockMediaOwner } from './projectMedia'
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
  readonly agent?: {
    readonly conversationId: string
    readonly turnId: string
    /**
     * 这是一个后台任务：与任务行同一个事务登记进 `agent_jobs`，结束时据此判断要不要唤醒智能体。
     * 登记与任务同生同灭，worker 再快也不会在登记之前把它跑完。
     */
    readonly job?: {
      readonly toolCallId: string
      readonly wakeOnSuccess: boolean
      /** 提交这一刻的改图计划；唤醒轮接着它走。 */
      readonly plan?: AgentJobPlan
    }
  }
  /**
   * 云端项目里这个任务要接替的失败占位（项目元素 id）：单张重试时产物落回原来那个位置。
   * 它不在项目里、或不是失败占位时照常另找位置。
   */
  readonly projectSlot?: string
}

export type CreateQueueTaskOutcome =
  | { readonly kind: 'created'; readonly taskId: string; readonly submittedAt: number }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'idempotency_mismatch' }
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function commandHash(input: CreateQueueTaskInput) {
  const { device_id: _device, client_request_id: _command, ...request } = input.request
  return createHash('sha256')
    .update(
      canonicalJson({
        provider: input.provider,
        model: input.model,
        request: {
          ...request,
          n: request.n ?? 1,
          ...(!input.video && input.provider === 'openai-compat'
            ? { moderation: request.moderation ?? DEFAULT_IMAGE_MODERATION }
            : {}),
        },
        video: input.video,
        // 唤醒选择不是请求的一部分：同一条命令换个选择重放，仍是同一个任务。
        agent: input.agent && {
          conversationId: input.agent.conversationId,
          turnId: input.agent.turnId,
        },
      }),
    )
    .digest('hex')
}
async function replayCommand(
  database: Pick<typeof db, 'select'>,
  userId: string,
  commandId: string,
  hash: string,
) {
  const [receipt] = await database
    .select()
    .from(schema.generation_commands)
    .where(
      and(
        eq(schema.generation_commands.user_id, userId),
        eq(schema.generation_commands.command_id, commandId),
      ),
    )
  if (!receipt) return null
  return receipt.request_hash === hash
    ? { kind: 'created' as const, taskId: receipt.task_id, submittedAt: receipt.submitted_at }
    : { kind: 'idempotency_mismatch' as const }
}

async function adoptLegacyCommand(
  userId: string,
  commandId: string,
  hash: string,
): Promise<CreateQueueTaskOutcome | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-command', userId, commandId])}, 0))`,
    )
    const replay = await replayCommand(tx, userId, commandId, hash)
    if (replay) return replay
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.user_id, userId), eq(schema.tasks.client_request_id, commandId)))
      .limit(1)
      .for('update')
    if (!task) return null
    const provider = asQueueProvider(task.provider)
    // Agent mask preparation changes the original request, so it cannot be reconstructed safely.
    if (!provider || task.request_payload.preserve_outside_mask)
      return { kind: 'idempotency_mismatch' }
    let originalHash: string
    try {
      const { video, ...payload } = task.request_payload
      const { video: _video, ...request } = await hydrateInputImages(payload)
      originalHash = commandHash({
        provider,
        model: task.model,
        request,
        video,
        userId,
        ...(task.agent_conversation_id && task.agent_turn_id
          ? {
              agent: { conversationId: task.agent_conversation_id, turnId: task.agent_turn_id },
            }
          : {}),
      })
    } catch {
      return { kind: 'object_storage_error', message: 'Original task inputs could not be read' }
    }
    // The task lock prevents retention from deleting the identity before its receipt is durable.
    await tx.insert(schema.generation_commands).values({
      user_id: userId,
      command_id: commandId,
      request_hash: originalHash,
      task_id: task.id,
      submitted_at: task.submitted_at,
    })
    return originalHash === hash
      ? { kind: 'created', taskId: task.id, submittedAt: task.submitted_at }
      : { kind: 'idempotency_mismatch' }
  })
}

/**
 * 「这是不是一次遮罩提交」只在这里判一次：`preserve_outside_mask` 与 `masked_original_size`
 * 描述同一个判定，要么都写、要么都不写，由这一个返回值保证。
 * `prepareMaskedInput` 不合规时抛 `TypeError`，由调用方翻成 `invalid_input_image`。
 */
async function prepareMaskedSubmission(input: CreateQueueTaskInput) {
  const request = input.request
  if (!input.agent || !request.mask || input.video) return undefined
  const strict = await prepareMaskedInput(
    input.model,
    request.input_images?.[0] ?? '',
    request.mask,
  )
  const { output_compression: _compression, ...rest } = request
  return {
    request: {
      ...rest,
      input_images: [strict.source, ...request.input_images!.slice(1)],
      mask: strict.mask,
      size: strict.size,
      // 保护选区外像素要逐像素比对，有损格式与压缩会把它毁掉。
      output_format: 'png' as const,
    },
    facts: {
      preserve_outside_mask: true as const,
      masked_original_size: strict.originalSize,
    },
  }
}

export async function createQueueTask(
  input: CreateQueueTaskInput,
): Promise<CreateQueueTaskOutcome> {
  const commandId = input.request.client_request_id
  const hash = commandHash(input)
  if (input.userId && commandId) {
    const replay = await replayCommand(db, input.userId, commandId, hash)
    if (replay) return replay
    const legacy = await adoptLegacyCommand(input.userId, commandId, hash)
    if (legacy) return legacy
  }
  const id = crypto.randomUUID()
  let requestPayload: PersistedSubmitRequest
  try {
    const masked = await prepareMaskedSubmission(input)
    requestPayload = {
      ...(await archiveInputImages(id, masked?.request ?? input.request)),
      ...(input.video ? { video: input.video } : {}),
      ...masked?.facts,
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
  if (input.provider === 'openai-compat' && !input.video) {
    requestPayload.moderation ??= DEFAULT_IMAGE_MODERATION
  }

  const now = Date.now()
  const pricing = pricingOf(input)
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const dailyQuotaEnabled = isCapabilityEnabled('quota:daily')
  const dailyImageQuota = config.operator.quotas['generation:daily-images']
  const outcome = await db.transaction(async (tx) => {
    const projectOutput =
      input.userId && input.agent && !input.video && isCapabilityEnabled('accounts:sync')
    if (projectOutput) await lockMediaOwner(tx, input.userId!)
    if (input.userId && commandId) {
      // A per-command transaction lock also covers the first submission, before a receipt exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-command', input.userId, commandId])}, 0))`,
      )
      const replay = await replayCommand(tx, input.userId, commandId, hash)
      if (replay) return replay
    }
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
    if (input.userId && commandId)
      await tx.insert(schema.generation_commands).values({
        user_id: input.userId,
        command_id: commandId,
        request_hash: hash,
        task_id: id,
        submitted_at: now,
      })
    if (projectOutput)
      await reserveProjectOutputs(tx, {
        userId: input.userId!,
        generationId: id,
        conversationId: input.agent!.conversationId,
        turnId: input.agent!.turnId,
        count: input.request.n ?? 1,
        ...(input.projectSlot ? { replaceObjectId: input.projectSlot } : {}),
      })
    if (input.agent?.job)
      await tx.insert(schema.agent_jobs).values({
        task_id: id,
        conversation_id: input.agent.conversationId,
        turn_id: input.agent.turnId,
        tool_call_id: input.agent.job.toolCallId,
        wake_on_success: input.agent.job.wakeOnSuccess,
        plan: input.agent.job.plan ?? null,
        submitted_at: now,
      })
    await publishGenerations(tx, [id])
    return {
      kind: 'created' as const,
      taskId: inserted[0]!.id,
      submittedAt: inserted[0]!.submitted_at,
    }
  })

  if (outcome.kind !== 'created' || outcome.taskId !== id) await discardArchivedInputs(id)
  if (outcome.kind === 'idempotency_conflict' && input.userId && commandId) {
    return (await adoptLegacyCommand(input.userId, commandId, hash)) ?? outcome
  }
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
  | {
      readonly kind: 'failed'
      readonly reason: string
      /** worker 记下的失败类型；等超时记 `upstream_timeout`，完成却没图记 `upstream_no_image`。 */
      readonly errorType: TaskErrorType | null
      /** 任务被取消（轮中止、会话删除），不是上游失败。 */
      readonly cancelled?: true
      /** 等待预算用完时任务还没到终态：它可能仍在跑、仍会出图计费，由调用方决定怎么收场。 */
      readonly stillRunning?: true
    }

/** 读一条队列任务的终局要用到的那几列。 */
export interface QueueTaskTerminalRow {
  readonly status: TaskStatus
  readonly provider: string
  readonly result_payload: unknown
  readonly error_message: string | null
  readonly error_type: string | null
}

/** 任务行此刻的终局；还没到终态就是 null。等结果与后台任务结算读的是同一个算式。 */
export function queueTaskOutcome(task: QueueTaskTerminalRow): QueueTaskOutcome | null {
  if (task.status === 'failed') {
    return {
      kind: 'failed',
      reason: task.error_message ?? '任务失败',
      // 列是自由文本；写它的只有 worker，值域就是 `TaskErrorType`。
      errorType: (task.error_type as TaskErrorType | null) ?? null,
    }
  }
  if (task.status === 'cancelled')
    return { kind: 'failed', reason: '任务被取消了', errorType: null, cancelled: true }
  if (task.status === 'completed') {
    const provider = asQueueProvider(task.provider)
    if (!provider)
      return { kind: 'failed', reason: `未知的上游：${task.provider}`, errorType: 'unknown' }
    const result = extractMeta(provider, task.result_payload)
    if (result.images.length === 0) {
      return {
        kind: 'failed',
        reason: describeEmptyResult(provider, task.result_payload),
        errorType: 'upstream_no_image',
      }
    }
    return { kind: 'completed', result }
  }
  return null
}

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
        error_type: schema.tasks.error_type,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    if (!task) return { kind: 'failed', reason: '任务丢失了', errorType: 'unknown' }

    if (task.status !== announced) {
      announced = task.status
      options.onStatus?.(task.status)
    }
    const settled = queueTaskOutcome(task)
    if (settled) return settled

    const waited = Date.now() - startedAt
    if (waited > polling.budgetMs)
      return {
        kind: 'failed',
        reason: '超时未返回',
        errorType: 'upstream_timeout',
        stillRunning: true,
      }
    await delay(nextInterval(waited), undefined, { signal: options.signal })
  }
}
