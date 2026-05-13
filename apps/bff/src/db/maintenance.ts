import { sqlite } from './client'

/** 30 天前的成品任务一律清掉。 */
const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * BFF 启动时跑一次：把启动前残留的 `queued` / `in_progress` task 推到 `failed`。
 *
 * 这两种状态都是孤儿：
 * - `queued`：submit 写表后 fire-and-forget 调 runTask，BFF 这次进程没起来
 *   这次调用就丢了。新进程不重新 enqueue（重试上游可能产生重复消耗），直接
 *   标 failed，由用户决定是否重提。
 * - `in_progress`：worker 调上游中途被 kill。同上不重试。
 *
 * 前端 poll 看到 status='failed' 后会把 task 转 error；如果有 clientRequestId
 * 但提交期间被中断（task 卡 queued），下一次 reload 也会被这条清掉，前端可
 * 走「重新提交」按钮。
 */
export function recoverInterruptedTasks(): number {
  const stmt = sqlite.prepare(
    `UPDATE tasks
       SET status = 'failed',
           error_message = ?,
           error_type = ?,
           completed_at = ?
     WHERE status IN ('queued', 'in_progress')`,
  )
  const result = stmt.run('BFF 重启时中断', 'interrupted', Date.now())
  return result.changes
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
