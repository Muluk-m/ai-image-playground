import { sqlite } from './client'
import { runTask } from '../workers/task-runner'

/** 30 天前的成品任务一律清掉。 */
const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * BFF 启动时跑一次：把启动前残留的 task 分两类处理。
 *
 * - **queued**：submit 写表后 fire-and-forget 调 runTask，但 BFF 这次进程没起
 *   来这次调用就丢了。**上游没动过**，重新调 runTask 让它继续推进，前端 poll
 *   感知不到（status 还是 queued/in_progress）。
 * - **in_progress**：worker 已经把 status 推到 in_progress，**几乎只能是上游
 *   fetch 已经发出后进程被外部 kill**——sub2api 那边可能在跑，再发一次会重
 *   复消耗配额。所以一律标 failed，由用户决定是否手动重试。
 *
 * 这种分法的副产品：用户在「提交瞬间正好碰上重启」时完全无感（最常见的窗口），
 * 只有「BFF 在调上游过程中被 kill」会被标 failed 让用户重试。
 */
export function recoverInterruptedTasks(): { retried: number; failed: number } {
  const queuedRows = sqlite
    .prepare("SELECT id FROM tasks WHERE status = 'queued'")
    .all() as Array<{ id: string }>
  for (const row of queuedRows) {
    runTask(row.id).catch((err) =>
      console.error(`[task-runner ${row.id}] crashed during startup recovery`, err),
    )
  }

  const failedStmt = sqlite.prepare(
    `UPDATE tasks
       SET status = 'failed',
           error_message = ?,
           error_type = ?,
           completed_at = ?
     WHERE status = 'in_progress'`,
  )
  const failedResult = failedStmt.run('BFF 重启时中断', 'interrupted', Date.now())

  return { retried: queuedRows.length, failed: failedResult.changes }
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；启动时的 recoverInterruptedTasks 已经把那两种状态归零。
 */
export function purgeOldTasks(retentionMs = TASK_RETENTION_MS): number {
  const threshold = Date.now() - retentionMs
  const stmt = sqlite.prepare(
    `DELETE FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at IS NOT NULL
        AND completed_at < ?`,
  )
  const result = stmt.run(threshold)
  return result.changes
}
