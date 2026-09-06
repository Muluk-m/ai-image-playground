import type { TaskErrorType } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { db, schema } from './client'

/**
 * 每个状态写入都带 `status='in_progress'` 守卫：cancel route 已经把 status 写成
 * 'cancelled' 时，worker 这边一律 no-op，不会反悔覆盖。
 */
const stillRunning = (id: string) =>
  and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'))

/** 回队时一律抹掉的上一次尝试痕迹。新增「每次尝试」列时改这里，别只加进某一个 requeue。 */
const CLEARED_ON_REQUEUE = {
  status: 'queued',
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
): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({ ...CLEARED_ON_REQUEUE, attempt_count: attemptJustFailed, next_retry_at: nextRetryAt })
    .where(stillRunning(id))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

/**
 * 把中断的异步任务退回 queued 以**继续轮询**：保留 upstream_task_ids 与 attempt_count。
 * 上游任务还活着且已计费，这不是一次失败的尝试，不进重试预算。返回真的改到的行数。
 */
export async function requeueTasksForPolling(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const updated = await db
    .update(schema.tasks)
    .set({ ...CLEARED_ON_REQUEUE, next_retry_at: null })
    .where(and(inArray(schema.tasks.id, [...ids]), eq(schema.tasks.status, 'in_progress')))
    .returning({ id: schema.tasks.id })
  return updated.length
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
      outcome: update.status,
      upstreamInvocationCount: finished.upstreamInvocationCount,
      errorType: update.errorType ?? null,
      upstreamStatus: update.upstreamStatus ?? null,
    })
    return true
  })
}
