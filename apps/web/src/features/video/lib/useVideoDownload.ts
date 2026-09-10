import { useSyncExternalStore } from 'react'
import { useStore } from '../../../store'
import type { VideoTask } from '../types'
import { downloadProgressLabel, downloadVideoTask, type VideoDownloadProgress } from './playback'

// 一条视频的卡片和灯箱会同时挂载，进度按 task 存：各存各的就等于每个视图都还能再下一次。
const active = new Map<string, { controller: AbortController; progress: VideoDownloadProgress }>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function cancelVideoDownload(taskId: string): void {
  active.get(taskId)?.controller.abort()
}

/** 下载中的按钮文案与重复点击拦截。 */
export function useVideoDownload(task: VideoTask, idleLabel: string) {
  const progress = useSyncExternalStore(subscribe, () => active.get(task.id)?.progress)

  const start = async () => {
    if (active.has(task.id)) return
    const controller = new AbortController()
    const publish = (next: VideoDownloadProgress) => {
      active.set(task.id, { controller, progress: next })
      notify()
    }
    const { showToast } = useStore.getState()
    publish({ received: 0, total: null })
    try {
      await downloadVideoTask(task, { signal: controller.signal, onProgress: publish })
      showToast('开始下载', 'success')
    } catch (error) {
      if (!controller.signal.aborted) {
        showToast(error instanceof Error ? error.message : String(error), 'error')
      }
    } finally {
      active.delete(task.id)
      notify()
    }
  }

  return {
    downloading: progress !== undefined,
    label: progress ? downloadProgressLabel(progress) : idleLabel,
    start,
  }
}
