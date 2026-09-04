import type { TaskRecord } from '../../../types'

export type HistoryItem =
  | { kind: 'task'; task: TaskRecord }
  | { kind: 'set'; setId: string; tasks: TaskRecord[] }

/** 套内任务折成一条，落在它最新一条任务的位置上；调用方已按时间排好序。 */
export function groupTasksBySet(tasks: readonly TaskRecord[]): HistoryItem[] {
  const items: HistoryItem[] = []
  const bySetId = new Map<string, Extract<HistoryItem, { kind: 'set' }>>()

  for (const task of tasks) {
    const setId = task.origin?.setId
    if (!setId) {
      items.push({ kind: 'task', task })
      continue
    }
    const existing = bySetId.get(setId)
    if (existing) {
      existing.tasks.push(task)
      continue
    }
    const group: Extract<HistoryItem, { kind: 'set' }> = { kind: 'set', setId, tasks: [task] }
    bySetId.set(setId, group)
    items.push(group)
  }

  return items
}
