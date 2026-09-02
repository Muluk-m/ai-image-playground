import type { TaskErrorType } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { db, schema } from './client'

/**
 * 每个状态写入都带 `status='in_progress'` 守卫：cancel route 已经把 status 写成
 * 'cancelled' 时，worker 这边一律 no-op，不会反悔覆盖。
 */
const stillRunning = (id: string) =>
  and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'))

/** 把在跑的任务退回 queued 等下一次尝试。返回是否真的改到了行。 */
export async function requeueTask(
  id: string,
  attemptJustFailed: number,
  nextRetryAt: number,
): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({
      status: 'queued',
      attempt_count: attemptJustFailed,
      next_retry_at: nextRetryAt,
      // 清空上一次尝试的痕迹；started_at 保留首次启动时间，admin 查耗时仍可用 submitted→completed。
      error_message: null,
      error_type: null,
      result_payload: null,
      upstream_status: null,
      upstream_body: null,
      // 必须清：下一次尝试是一个全新的上游任务，留着旧 id 会让它去轮一个已经终态的任务，
      // 永远出不来。
      upstream_task_ids: null,
      upstream_submitted_at: null,
    })
    .where(stillRunning(id))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

/**
 * 把中断的异步任务退回 queued 以**继续轮询**：保留 upstream_task_ids 与 attempt_count。
 * 上游任务还活着且已计费，这不是一次失败的尝试，不进重试预算。
 */
export async function requeueTaskForPolling(id: string): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({
      status: 'queued',
      next_retry_at: null,
      error_message: null,
      error_type: null,
      result_payload: null,
      upstream_status: null,
      upstream_body: null,
    })
    .where(stillRunning(id))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

export type TerminalTaskUpdate = {
  status: 'completed' | 'failed'
  completedAt: number
  attemptCount?: number
  resultPayload?: (typeof schema.tasks.$inferInsert)['result_payload']
  errorMessage?: string
  errorType?: TaskErrorType
  upstreamStatus?: number | null
  upstreamBody?: string | null
}

/** 写终态并触发私有 overlay 的结算 / 退回。返回是否真的改到了行。 */
export async function finishTask(id: string, update: TerminalTaskUpdate): Promise<boolean> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const [finished] = await tx
      .update(schema.tasks)
      .set({
        status: update.status,
        attempt_count: update.attemptCount,
        result_payload: update.resultPayload,
        error_message: update.errorMessage,
        error_type: update.errorType,
        upstream_status: update.upstreamStatus,
        upstream_body: update.upstreamBody,
        completed_at: update.completedAt,
      })
      .where(stillRunning(id))
      .returning({
        id: schema.tasks.id,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
      })
    if (!finished) return false
    await taskHooks.finalizeTask({
      tx,
      taskId: finished.id,
      upstreamInvocationCount: finished.upstreamInvocationCount,
    })
    return true
  })
}
