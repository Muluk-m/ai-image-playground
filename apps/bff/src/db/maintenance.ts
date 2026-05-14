import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { db, schema } from './client'
import { spawnTask } from '../workers/task-runner'

/**
 * BFF 启动时跑一次：把启动前残留的 task 分两类处理。
 *
 * - **queued**：submit 写表后 fire-and-forget 调 runTask，但 BFF 这次进程没起
 *   来这次调用就丢了。上游没动过，重新 spawnTask 让它继续推进，前端 poll
 *   感知不到（status 仍是 queued/in_progress）。
 * - **in_progress**：worker 几乎只能是上游 fetch 已经发出后进程被外部 kill；
 *   sub2api 那边可能在跑，再发一次会重复消耗配额。一律标 failed，由用户决定
 *   是否手动重试。
 */
export async function recoverInterruptedTasks(): Promise<{ retried: number; failed: number }> {
  const queuedRows = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'queued'))

  for (const row of queuedRows) {
    spawnTask(row.id, 'startup recovery')
  }

  const failed = await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      error_message: 'BFF 重启时中断',
      error_type: 'interrupted' as const,
      completed_at: Date.now(),
    })
    .where(eq(schema.tasks.status, 'in_progress'))
    .returning({ id: schema.tasks.id })

  return { retried: queuedRows.length, failed: failed.length }
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；启动时的 recoverInterruptedTasks 已经把那两种状态归零。
 */
export async function purgeOldTasks(
  retentionMs = QUEUE_TIMEOUTS.TASK_RETENTION_MS,
): Promise<number> {
  const threshold = Date.now() - retentionMs
  const deleted = await db
    .delete(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
        isNotNull(schema.tasks.completed_at),
        lt(schema.tasks.completed_at, threshold),
      ),
    )
    .returning({ id: schema.tasks.id })
  return deleted.length
}
