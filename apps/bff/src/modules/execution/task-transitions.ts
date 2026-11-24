import {
  type AgentToolErrorCode,
  degradeGptImage26ForSub2api,
  type GptTierInput,
  gptImage26RateMultiplier,
  isGptDirectModel,
  isGptImage26Model,
  isGptSub2apiDeliverable,
  QUEUE_TIMEOUTS,
  queueTask,
  type TaskErrorType,
} from '@image-playground/shared'
import { and, eq, gt, inArray, type SQL, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { publishGenerations } from '../../db/generation-events'
import {
  assertTaskLifecycleListenerRegistered,
  type ExecutionTaskUsage,
  type ExecutionTransaction,
  emitTaskFinished,
  emitTaskFinishedAfterCommit,
  emitTasksCancelled,
  emitTasksCancelledAfterCommit,
  type GenerationMediaLink,
  prepareTaskLifecycleStage,
  type TaskFinishedEvent,
  type TasksCancelledEvent,
  type TerminalTaskStatus,
} from './task-lifecycle-bus'
import { syncTaskPayloads } from './task-payloads'

/**
 * 「这一行还归这个执行者」：令牌对得上，租约还没过。过期的执行者可以跑完一次 fetch，
 * 但再也发布不了、结算不了它的结果。worker 侧由执行句柄自动带上，非 worker 的调用方
 * （对话轮结算）自己显式给出。
 */
export function heldBy(token: string): SQL {
  return and(
    eq(schema.tasks.execution_token, token),
    gt(schema.tasks.lease_expires_at, Date.now()),
  )!
}

/**
 * 每个状态写入都带 `status='in_progress'` 与调用方的归属守卫：cancel route 已经
 * 把 status 写成 'cancelled' 时，worker 一律 no-op；旧执行者也不能写新执行者的行。
 * worker 经执行句柄传入令牌与租约守卫，回收扫描传入它扫到的令牌守卫。
 */
const stillRunning = (id: string, fence: SQL) =>
  and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'), fence)

/** 回队时一律抹掉的上一次尝试痕迹。新增「每次尝试」列时改这里，别只加进某一个 requeue。 */
const CLEARED_ON_REQUEUE = {
  status: 'queued',
  execution_token: null,
  lease_expires_at: null,
  error_message: null,
  error_type: null,
  result_payload: null,
  upstream_status: null,
  upstream_body: null,
} as const satisfies Partial<typeof schema.tasks.$inferInsert>

/**
 * 把在跑的任务退回 queued 等下一次尝试。返回是否真的改到了行。
 * upstream_task_ids 故意不清：上游没有幂等键，已落库的 id 重提一次就是重复计费，
 * 所以下一次尝试只能轮它们、只补提交缺口。
 */
export async function requeueTask(
  id: string,
  attemptJustFailed: number,
  nextRetryAt: number,
  fence: SQL,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({ ...CLEARED_ON_REQUEUE, attempt_count: attemptJustFailed, next_retry_at: nextRetryAt })
      .where(stillRunning(id, fence))
      .returning({ id: schema.tasks.id })
    const ids = updated.map((row) => row.id)
    await syncTaskPayloads(tx, ids)
    await publishGenerations(tx, ids)
    return updated.length > 0
  })
}

/**
 * 把中断的异步任务退回 queued 以**继续轮询**：保留 upstream_task_ids 与 attempt_count。
 * 上游任务还活着且已计费，这不是一次失败的尝试，不进重试预算。返回真的改到的行数。
 */
export async function requeueTasksForPolling(ids: readonly string[], fence: SQL): Promise<number> {
  if (ids.length === 0) return 0
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({ ...CLEARED_ON_REQUEUE, next_retry_at: null })
      .where(and(inArray(schema.tasks.id, [...ids]), eq(schema.tasks.status, 'in_progress'), fence))
      .returning({ id: schema.tasks.id })
    const updatedIds = updated.map((row) => row.id)
    await syncTaskPayloads(tx, updatedIds)
    await publishGenerations(tx, updatedIds)
    return updated.length
  })
}

export async function saveArchiveCheckpoint(
  id: string,
  payload: (typeof schema.tasks.$inferInsert)['archive_payload'],
  fence: SQL,
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({
        archive_payload: payload,
        archive_retry_started_at: sql`coalesce(${schema.tasks.archive_retry_started_at}, now())`,
      })
      .where(stillRunning(id, fence))
      .returning({ id: schema.tasks.id })
    const ids = updated.map((row) => row.id)
    await syncTaskPayloads(tx, ids)
    await publishGenerations(tx, ids)
    return updated.length > 0
  })
}

/** Archive retries keep the successful result and never consume model attempts. */
export async function requeueTaskArchive(
  id: string,
  nextRetryAt: number,
  payload: (typeof schema.tasks.$inferInsert)['archive_payload'] | undefined,
  fence: SQL,
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({
        status: 'queued',
        next_retry_at: nextRetryAt,
        archive_payload: payload,
        archive_retry_started_at: sql`coalesce(${schema.tasks.archive_retry_started_at}, now())`,
        error_message: '图片已生成，正在重试保存',
        error_type: 'object_storage_error',
      })
      .where(stillRunning(id, fence))
      .returning({ id: schema.tasks.id })
    const ids = updated.map((row) => row.id)
    await syncTaskPayloads(tx, ids)
    await publishGenerations(tx, ids)
    return updated.length > 0
  })
}

/** Quarantine an uncertain dispatch without finalizing its billing hold. */
export async function reconcileTasks(
  access: SQL,
  reason: string,
  executor?: ExecutionTransaction,
): Promise<string[]> {
  const reconcile = async (tx: ExecutionTransaction) => {
    const enteredAt = Date.now()
    const rows = await tx
      .update(schema.tasks)
      .set({
        status: 'reconciling',
        error_type: 'upstream_result_unknown',
        error_message: reason,
        execution_token: null,
        lease_expires_at: null,
        // 进入时刻单独记下，给 30 分钟告警和卡片用。next_retry_at 只表示下次核对，
        // 认领队列只看 status=queued，这里把它拨到 5 分钟后，核对失败再继续往后推。
        reconcile_started_at: enteredAt,
        reconcile_alerted_at: null,
        next_retry_at: enteredAt + QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS,
        completed_at: null,
      })
      .where(
        and(
          access,
          eq(schema.tasks.reconciliation_required, true),
          eq(schema.tasks.status, 'in_progress'),
          gt(schema.tasks.upstream_invocation_count, 0),
        ),
      )
      .returning({ id: schema.tasks.id })
    const ids = rows.map((row) => row.id)
    await publishGenerations(tx, ids)
    return ids
  }
  return executor ? reconcile(executor) : db.transaction(reconcile)
}

function queueTerminalStatus(status: TerminalTaskStatus): TerminalTaskStatus {
  const event = status === 'completed' ? 'succeed' : status === 'failed' ? 'fail' : 'cancel'
  const next = queueTask.target(event)
  if (next !== 'completed' && next !== 'failed' && next !== 'cancelled') {
    throw new Error(`queue-task: ${event} did not resolve to a terminal status`)
  }
  return next
}

export type TerminalTaskUpdate = {
  status: TerminalTaskStatus
  completedAt: number
  attemptCount?: number
  /** 对话轮自己数上游调了几次；生图任务不传，沿用行上累计的那个数。 */
  upstreamInvocationCount?: number
  resultPayload?: (typeof schema.tasks.$inferInsert)['result_payload']
  errorMessage?: string
  errorType?: TaskErrorType
  upstreamStatus?: number | null
  upstreamBody?: string | null
  actualUsage?: ExecutionTaskUsage
  media?: GenerationMediaLink[]
  /** Keep the generated source for operator recovery after archive retries expire. */
  preserveArchive?: boolean
}

/**
 * GPT 的 2K/4K/高画质落到 sub2api 只出得了 1K：按任务行记的通道把倍率改回 1，差额随结算退回。
 * 执行、归档重试、对账三条完成路径都经这里，不靠上游 payload 里的标记（会丢，也可能被伪造）。
 */
export function gptSettledUsage(
  update: TerminalTaskUpdate,
  task: { model: string; request: GptTierInput & { n?: number }; gptRoute: string | null },
): ExecutionTaskUsage | undefined {
  if (update.status !== 'completed' || task.gptRoute !== 'sub2api') return update.actualUsage
  const quantity = update.actualUsage?.quantity ?? Math.max(1, task.request.n ?? 1)
  if (isGptImage26Model(task.model)) {
    const degraded = degradeGptImage26ForSub2api(task.request)
    if (!degraded) return update.actualUsage
    return { quantity, unitMultiplier: gptImage26RateMultiplier(degraded.request) }
  }
  if (!isGptDirectModel(task.model) || isGptSub2apiDeliverable(task.request))
    return update.actualUsage
  return { quantity, unitMultiplier: 1 }
}

/**
 * 写终态并通过事务内 TaskLifecycleBus 触发媒体、画布、计费结算、模型下架与智能体唤醒。
 * 返回是否真的改到了行。
 * worker 一律经执行句柄（`workers/task-execution`）调它；回收扫描与对话轮结算自己给 fence。
 */
export interface ExternalExecutionTransaction {
  readonly tx: ExecutionTransaction
  /** 外部事务调用方必须登记并在事务提交后执行提交后钩子，防止静默跳过终态投影。 */
  readonly onCommit: (hook: () => Promise<void>) => void
}

export async function finishTask(
  id: string,
  update: TerminalTaskUpdate,
  fence: SQL,
  reconciliation?: ExternalExecutionTransaction,
): Promise<boolean> {
  await prepareTaskLifecycleStage('settlement')
  let committedEvent: TaskFinishedEvent | null = null
  const finish = async (tx: ExecutionTransaction) => {
    const status = queueTerminalStatus(update.status)
    const [finished] = await tx
      .update(schema.tasks)
      .set({
        status,
        ...(update.preserveArchive ? {} : { archive_payload: null }),
        attempt_count: update.attemptCount,
        upstream_invocation_count: update.upstreamInvocationCount,
        result_payload: update.resultPayload,
        error_message: update.errorMessage ?? null,
        error_type: update.errorType ?? null,
        upstream_status: update.upstreamStatus,
        upstream_body: update.upstreamBody,
        completed_at: update.completedAt,
      })
      .where(
        reconciliation
          ? and(
              eq(schema.tasks.id, id),
              eq(schema.tasks.status, 'reconciling'),
              eq(schema.tasks.reconciliation_required, true),
              fence,
            )
          : stillRunning(id, fence),
      )
      .returning({
        id: schema.tasks.id,
        kind: schema.tasks.kind,
        agentConversationId: schema.tasks.agent_conversation_id,
        agentTurnId: schema.tasks.agent_turn_id,
        userId: schema.tasks.user_id,
        model: schema.tasks.model,
        metering: schema.tasks.metering,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
        request: schema.tasks.request_payload,
        gptRoute: schema.tasks.gpt_route,
      })
    if (!finished) return false
    await syncTaskPayloads(tx, [finished.id])
    const meteringMode = finished.metering?.mode === 'none' ? 'none' : 'credits'
    const event: TaskFinishedEvent = {
      taskId: finished.id,
      taskKind: finished.kind,
      agentConversationId: finished.agentConversationId,
      agentTurnId: finished.agentTurnId,
      userId: finished.userId,
      model: finished.model,
      status,
      completedAt: update.completedAt,
      errorType: update.errorType,
      upstreamStatus: update.upstreamStatus ?? null,
      upstreamInvocationCount: finished.upstreamInvocationCount,
      meteringMode,
      actualUsage: gptSettledUsage(update, finished),
      resultPayload: update.resultPayload,
      media: update.media,
    }
    await emitTaskFinished(tx, 'before-settlement', event)
    if (meteringMode !== 'none') {
      assertTaskLifecycleListenerRegistered('billing-settlement')
      await emitTaskFinished(tx, 'settlement', event)
    }
    await emitTaskFinished(tx, 'after-settlement', event)
    await publishGenerations(tx, [finished.id])
    committedEvent = event
    return true
  }
  if (reconciliation) {
    const written = await finish(reconciliation.tx)
    if (written && committedEvent) {
      const event = committedEvent
      reconciliation.onCommit(() => emitTaskFinishedAfterCommit(event))
    }
    return written
  }
  const written = await db.transaction(finish)
  if (written && committedEvent) {
    await emitTaskFinishedAfterCommit(committedEvent)
  }
  return written
}

export type CancelTasksOptions =
  | {
      readonly failedAs?: AgentToolErrorCode
      readonly tx?: undefined
      readonly onCommit?: undefined
    }
  | ({ readonly failedAs?: AgentToolErrorCode } & ExternalExecutionTransaction)

/**
 * 取消状态和积分退回必须在同一事务中提交；调用方提供任务归属范围。
 * `failedAs`：这次撤回在用户看来是一次失败（智能体等不到结果撤掉的任务算超时），项目里预留的
 * 位置留作带这个码的失败占位；缺席即用户主动取消，预留位置直接收掉。
 * `tx`：调用方已经开了事务（删会话、CLI 取消等）时必须同步传入 `onCommit`，由外层在事务提交后执行提交后钩子。
 */
export async function cancelTasks(access: SQL, options: CancelTasksOptions = {}) {
  await prepareTaskLifecycleStage('settlement')
  let committedEvent: TasksCancelledEvent | null = null
  const cancel = async (tx: ExecutionTransaction) => {
    // Serialize cancellation with the dispatch-intent write; no request can slip between them.
    await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(access, inArray(schema.tasks.status, ['queued', 'in_progress'])))
      .for('update')
    await reconcileTasks(access, '已提交的请求仍待核查，预扣暂时保留', tx)
    const status = queueTerminalStatus('cancelled')
    const completedAt = Date.now()
    const rows = await tx
      .update(schema.tasks)
      .set({ status, completed_at: completedAt })
      .where(and(access, inArray(schema.tasks.status, ['queued', 'in_progress'])))
      .returning({
        id: schema.tasks.id,
        kind: schema.tasks.kind,
        agentConversationId: schema.tasks.agent_conversation_id,
        agentTurnId: schema.tasks.agent_turn_id,
        userId: schema.tasks.user_id,
        metering: schema.tasks.metering,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
      })
    const event: TasksCancelledEvent = {
      tasks: rows.map((row) => ({
        taskId: row.id,
        taskKind: row.kind,
        agentConversationId: row.agentConversationId,
        agentTurnId: row.agentTurnId,
        userId: row.userId,
        meteringMode: row.metering?.mode === 'none' ? 'none' : 'credits',
        upstreamInvocationCount: row.upstreamInvocationCount,
      })),
      completedAt,
      failedAs: options.failedAs,
    }
    if (rows.length > 0) {
      await emitTasksCancelled(tx, 'before-settlement', event)
      if (event.tasks.some((task) => task.meteringMode !== 'none')) {
        assertTaskLifecycleListenerRegistered('billing-settlement')
        await emitTasksCancelled(tx, 'settlement', event)
      }
      await emitTasksCancelled(tx, 'after-settlement', event)
      committedEvent = event
    }
    await publishGenerations(
      tx,
      rows.map((row) => row.id),
    )
    return rows
  }
  if (options.tx) {
    const rows = await cancel(options.tx)
    if (committedEvent) {
      const event = committedEvent
      options.onCommit(() => emitTasksCancelledAfterCommit(event))
    }
    return rows
  }
  const rows = await db.transaction(cancel)
  if (committedEvent) {
    await emitTasksCancelledAfterCommit(committedEvent)
  }
  return rows
}
