import { useMemo } from 'react'
import { mergeHistory } from '../lib/platformGenerations'
import { useStore } from '../store'
import type { TaskRecord } from '../types'

/**
 * 作品页那一条时间线。
 *
 * 读时合并：本机记录是本机数据，平台记录是一份可整体替换的缓存（`lib/platformGenerations`），
 * 两者在这里投影成同一种卡。写时不合并——把平台状态抄进本机表，就得为它的删除、状态、
 * 参考图各写一条对账回头路。
 */
export function useHistoryTasks(): TaskRecord[] {
  const tasks = useStore((s) => s.tasks)
  const platformGenerations = useStore((s) => s.platformGenerations)
  return useMemo(() => mergeHistory(tasks, platformGenerations), [tasks, platformGenerations])
}
