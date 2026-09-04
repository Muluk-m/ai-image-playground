import type { TaskRecord } from '../../../types'

/** `queued` 是本轮排到但还没提交的镜头，任务记录里没有它。 */
export type ShotState = 'idle' | 'queued' | 'running' | 'done' | 'error'

export interface ShotProgress {
  state: ShotState
  error: string | null
  outputImageIds: string[]
}

export const SHOT_STATE_LABELS: Record<ShotState, string> = {
  idle: '未开始',
  queued: '排队',
  running: '生成中',
  done: '完成',
  error: '失败',
}

export function indexTasksById(tasks: readonly TaskRecord[]): ReadonlyMap<string, TaskRecord> {
  return new Map(tasks.map((task) => [task.id, task]))
}

export interface ShotTaskLink {
  id: string
  taskIds: readonly string[]
}

export function shotProgress(
  shot: ShotTaskLink,
  tasksById: ReadonlyMap<string, TaskRecord>,
  queuedShotIds: readonly string[],
): ShotProgress {
  const tasks = shot.taskIds.flatMap((id) => {
    const task = tasksById.get(id)
    return task ? [task] : []
  })
  const outputImageIds = tasks.flatMap((task) => task.outputImages)

  if (tasks.length === 0) {
    return {
      state: queuedShotIds.includes(shot.id) ? 'queued' : 'idle',
      error: null,
      outputImageIds,
    }
  }
  if (tasks.some((task) => task.status === 'running')) {
    return { state: 'running', error: null, outputImageIds }
  }
  const failed = tasks.find((task) => task.status === 'error')
  if (failed) return { state: 'error', error: failed.error, outputImageIds }
  return { state: 'done', error: null, outputImageIds }
}

export interface SetProgress {
  total: number
  done: number
  error: number
  running: number
}

export function setProgress(
  shots: readonly (ShotTaskLink & { enabled: boolean })[],
  tasksById: ReadonlyMap<string, TaskRecord>,
  queuedShotIds: readonly string[],
): SetProgress {
  const states = shots
    .filter((shot) => shot.enabled)
    .map((shot) => shotProgress(shot, tasksById, queuedShotIds).state)
  return {
    total: states.length,
    done: states.filter((state) => state === 'done').length,
    error: states.filter((state) => state === 'error').length,
    running: states.filter((state) => state === 'running').length,
  }
}
