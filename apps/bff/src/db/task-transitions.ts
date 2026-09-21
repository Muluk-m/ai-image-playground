import {
  type AgentToolErrorCode,
  type TaskErrorType,
  taskFailureCode,
} from '@image-playground/shared'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { agentJobsEnded } from '../lib/agent/wake'
import { type GenerationMediaLink, publishGenerationImages } from '../lib/generationMedia'
import { type BffTransaction, loadPrivateBffOverlay, type TaskUsage } from '../lib/private-overlay'
import { publishProjectOutputs } from '../lib/projectArchive'
import { db, schema } from './client'
import { executionFence } from './execution-context'
import { publishGenerations } from './generation-events'

/**
 * 每个状态写入都带 `status='in_progress'` 守卫：cancel route 已经把 status 写成
 * 'cancelled' 时，worker 这边一律 no-op，不会反悔覆盖。
 */
const stillRunning = (id: string, guard?: SQL) =>
  and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'), executionFence(), guard)

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
  guard?: SQL,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({ ...CLEARED_ON_REQUEUE, attempt_count: attemptJustFailed, next_retry_at: nextRetryAt })
      .where(stillRunning(id, guard))
      .returning({ id: schema.tasks.id })
    await publishGenerations(
      tx,
      updated.map((row) => row.id),
    )
    return updated.length > 0
  })
}

/**
 * 把中断的异步任务退回 queued 以**继续轮询**：保留 upstream_task_ids 与 attempt_count。
 * 上游任务还活着且已计费，这不是一次失败的尝试，不进重试预算。返回真的改到的行数。
 */
export async function requeueTasksForPolling(ids: readonly string[], guard?: SQL): Promise<number> {
  if (ids.length === 0) return 0
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({ ...CLEARED_ON_REQUEUE, next_retry_at: null })
      .where(and(inArray(schema.tasks.id, [...ids]), eq(schema.tasks.status, 'in_progress'), guard))
      .returning({ id: schema.tasks.id })
    await publishGenerations(
      tx,
      updated.map((row) => row.id),
    )
    return updated.length
  })
}

export async function saveArchiveCheckpoint(
  id: string,
  payload: (typeof schema.tasks.$inferInsert)['archive_payload'],
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({ archive_payload: payload })
      .where(stillRunning(id))
      .returning({ id: schema.tasks.id })
    await publishGenerations(
      tx,
      updated.map((row) => row.id),
    )
    return updated.length > 0
  })
}

/** Archive retries keep the successful result and never consume model attempts. */
export async function requeueTaskArchive(
  id: string,
  nextRetryAt = Date.now() + 60_000,
  payload?: (typeof schema.tasks.$inferInsert)['archive_payload'],
  guard?: SQL,
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.tasks)
      .set({
        status: 'queued',
        next_retry_at: nextRetryAt,
        archive_payload: payload,
        error_message: '图片已生成，正在重试保存',
        error_type: 'object_storage_error',
      })
      .where(stillRunning(id, guard))
      .returning({ id: schema.tasks.id })
    await publishGenerations(
      tx,
      updated.map((row) => row.id),
    )
    return updated.length > 0
  })
}

export type TerminalTaskUpdate = {
  status: 'completed' | 'failed' | 'cancelled'
  completedAt: number
  attemptCount?: number
  /** 对话轮自己数上游调了几次；生图任务不传，沿用行上累计的那个数。 */
  upstreamInvocationCount?: number
  resultPayload?: (typeof schema.tasks.$inferInsert)['result_payload']
  errorMessage?: string
  errorType?: TaskErrorType
  upstreamStatus?: number | null
  upstreamBody?: string | null
  actualUsage?: TaskUsage
  media?: GenerationMediaLink[]
}

/** 写终态并触发私有 overlay 的结算 / 退回。返回是否真的改到了行。 */
export async function finishTask(
  id: string,
  update: TerminalTaskUpdate,
  guard?: SQL,
): Promise<boolean> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const [finished] = await tx
      .update(schema.tasks)
      .set({
        status: update.status,
        archive_payload: null,
        attempt_count: update.attemptCount,
        upstream_invocation_count: update.upstreamInvocationCount,
        result_payload: update.resultPayload,
        error_message: update.errorMessage ?? null,
        error_type: update.errorType ?? null,
        upstream_status: update.upstreamStatus,
        upstream_body: update.upstreamBody,
        completed_at: update.completedAt,
      })
      .where(stillRunning(id, guard))
      .returning({
        id: schema.tasks.id,
        userId: schema.tasks.user_id,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
      })
    if (!finished) return false
    if (finished.userId && update.media) {
      await publishGenerationImages(tx, finished.userId, id, update.media)
    }
    if (finished.userId)
      await publishProjectOutputs(
        tx,
        finished.userId,
        id,
        update.media ?? [],
        update.status === 'failed' ? taskFailureCode(update.errorType) : undefined,
      )
    await taskHooks.finalizeTask({
      tx,
      taskId: finished.id,
      outcome: update.status,
      upstreamInvocationCount: finished.upstreamInvocationCount,
      errorType: update.errorType,
      upstreamStatus: update.upstreamStatus ?? null,
      actualUsage: update.actualUsage,
    })
    // 智能体的后台任务：同一个事务里判断要不要唤醒它，终态与唤醒要么一起落、要么都不落。
    await agentJobsEnded(tx, [finished.id], update.completedAt)
    await publishGenerations(tx, [finished.id])
    return true
  })
}
/**
 * 取消状态和积分退回必须在同一事务中提交；调用方提供任务归属范围。
 * `failedAs`：这次撤回在用户看来是一次失败（智能体等不到结果撤掉的任务算超时），项目里预留的
 * 位置留作带这个码的失败占位；缺席即用户主动取消，预留位置直接收掉。
 * `tx`：调用方已经开了事务（删会话时取消要与墓碑同一次提交），给出时就在它上面做。
 */
export async function cancelTasks(
  access: SQL,
  options: { failedAs?: AgentToolErrorCode; tx?: BffTransaction } = {},
) {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const cancel = async (tx: BffTransaction) => {
    const rows = await tx
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(and(access, inArray(schema.tasks.status, ['queued', 'in_progress'])))
      .returning({
        id: schema.tasks.id,
        userId: schema.tasks.user_id,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
      })
    for (const row of rows) {
      if (row.userId) await publishProjectOutputs(tx, row.userId, row.id, [], options.failedAs)
      await taskHooks.finalizeTask({
        tx,
        taskId: row.id,
        outcome: 'cancelled',
        upstreamInvocationCount: row.upstreamInvocationCount,
      })
    }
    // 取消的后台任务不唤醒，但它结束了：同一批里其余的可能正等着它。
    await agentJobsEnded(
      tx,
      rows.map((row) => row.id),
    )
    await publishGenerations(
      tx,
      rows.map((row) => row.id),
    )
    return rows
  }
  return options.tx ? cancel(options.tx) : db.transaction(cancel)
}
