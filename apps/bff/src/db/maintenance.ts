import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { log } from '../lib/logger'
import { objectStore } from '../lib/objectStore'
import { db, schema } from './client'

/**
 * worker 启动时跑一次：把上次进程残留的 in_progress 标成终态。
 *
 * queued 任务由数据库轮询 scheduler 自动发现，future next_retry_at 也保留在库中，
 * 不再创建进程内 setTimeout。in_progress 说明旧 worker 可能已经发出 fetch；
 *   上游那边可能在跑，再发一次会重复消耗配额。一律标 failed，由用户决定
 *   是否手动重试。
 */
export async function recoverInterruptedTasks(): Promise<{ failed: number }> {
  const failed = await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      error_message: '任务 worker 重启时中断',
      error_type: 'interrupted' as const,
      completed_at: Date.now(),
    })
    .where(eq(schema.tasks.status, 'in_progress'))
    .returning({ id: schema.tasks.id })

  return { failed: failed.length }
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；worker 启动时的 recoverInterruptedTasks 会收拾 in_progress。
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

  for (const task of deleted) {
    try {
      await objectStore().deletePrefix(`${task.id}/`)
    } catch (error) {
      log.warn(
        { event: 'object_store.cleanup_failed', taskId: task.id, err: String(error) },
        'task row deleted; object prefix left for lifecycle cleanup',
      )
    }
  }
  return deleted.length
}
