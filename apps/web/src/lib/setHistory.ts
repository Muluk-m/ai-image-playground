import type { TaskRecord } from '../types'

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

  for (const item of items)
    if (item.kind === 'set' && item.tasks[0]?.origin?.kind === 'batch')
      item.tasks = batchAttempts(item.tasks)
  return items
}

/**
 * 逐张生成的一组：每张参考图只留最新的一次尝试（重试顶替失败的那次），按参考图在条上的顺序排。
 */
function batchAttempts(tasks: readonly TaskRecord[]): TaskRecord[] {
  const latest = new Map<string, TaskRecord>()
  for (const task of tasks) {
    const shot = task.origin?.shotId ?? task.id
    const kept = latest.get(shot)
    if (!kept || task.createdAt > kept.createdAt) latest.set(shot, task)
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, task]) => task)
}
