import type { TaskRecord } from '../types'

export type TaskStatusFilter = 'all' | 'running' | 'done' | 'error'

/**
 * 生成记录按状态筛选。网格和批量操作条必须用同一份判据，否则「全选」会选中网格里看不见的卡。
 *
 * 被取消的任务落在 `error` 里，但它不是失败：「失败」筛选里不出现「已取消」的卡。
 */
export function taskMatchesStatusFilter(
  task: Pick<TaskRecord, 'status' | 'cancelled'>,
  filter: TaskStatusFilter,
): boolean {
  if (filter === 'all') return true
  if (task.status !== filter) return false
  return !(filter === 'error' && task.cancelled)
}
