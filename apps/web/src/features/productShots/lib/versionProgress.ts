import { i18next } from '../../../i18n'
import type { TaskRecord } from '../../../types'

/** `queued` 是已提交但任务记录还没到手的那一瞬，或记录已被历史清理带走。 */
export type VersionState = 'queued' | 'running' | 'done' | 'error'

export interface VersionProgress {
  state: VersionState
  error: string | null
  outputImageIds: string[]
  /** 进行中的起点，用来读秒；其它状态为 null。 */
  startedAt: number | null
  /** 结束后的总耗时毫秒；还没结束时为 null。 */
  elapsed: number | null
}

export function versionStateLabels(): Record<VersionState, string> {
  return {
    queued: i18next.t('version.state.queued', { ns: 'productShots' }),
    running: i18next.t('state.generating', { ns: 'common' }),
    done: i18next.t('state.done', { ns: 'common' }),
    error: i18next.t('state.failed', { ns: 'common' }),
  }
}

export function versionProgress(task: TaskRecord | undefined): VersionProgress {
  if (!task) {
    return { state: 'queued', error: null, outputImageIds: [], startedAt: null, elapsed: null }
  }

  const outputImageIds = task.outputImages
  if (task.status === 'running') {
    return {
      state: 'running',
      error: null,
      outputImageIds,
      startedAt: task.createdAt,
      elapsed: null,
    }
  }

  const elapsed =
    task.elapsed ?? (task.finishedAt === null ? null : task.finishedAt - task.createdAt)
  return {
    state: task.status === 'error' ? 'error' : 'done',
    error: task.status === 'error' ? task.error : null,
    outputImageIds,
    startedAt: null,
    elapsed,
  }
}
