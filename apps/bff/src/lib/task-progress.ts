import type { TaskProgressPhase, TaskStatus } from '@image-playground/shared'

/**
 * 没结束的任务此刻的持久阶段（ADR 0009）：执行器租约过期或重新排队但已有上游任务号时是
 * `reconnecting`，结果已归档待确认时是 `confirming`。队列状态查询与 Agent 后台任务共用这一份。
 */
export function taskProgressPhase(task: {
  status: TaskStatus
  archive_payload: unknown
  upstream_task_ids: string[] | null
  lease_expires_at: number | null
}): TaskProgressPhase {
  if (task.archive_payload) return 'confirming'
  if (task.status === 'queued') return task.upstream_task_ids?.length ? 'reconnecting' : 'queued'
  if (task.lease_expires_at != null && task.lease_expires_at <= Date.now()) return 'reconnecting'
  return 'generating'
}
