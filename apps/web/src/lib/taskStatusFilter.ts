import type { TaskRecord } from '../types'
import { activityFromRecord } from './generationActivity'

export type TaskStatusFilter = 'all' | 'running' | 'done' | 'error'

/**
 * 生成记录按状态筛选。网格和批量操作条必须用同一份判据，否则「全选」会选中网格里看不见的卡。
 *
 * 被取消的任务不是失败：「失败」筛选里不出现「已取消」的卡。
 */
export function taskMatchesStatusFilter(
  task: Pick<TaskRecord, 'status' | 'cancelled' | 'queuePhase' | 'batchQueued' | 'activity'>,
  filter: TaskStatusFilter,
): boolean {
  if (filter === 'all') return true
  const phase = activityFromRecord(task).phase
  if (filter === 'done') return phase === 'done'
  if (filter === 'error') return phase === 'failed' || phase === 'stale'
  return phase !== 'done' && phase !== 'failed' && phase !== 'cancelled' && phase !== 'stale'
}
