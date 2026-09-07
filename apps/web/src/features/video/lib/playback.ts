import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { VideoTask } from '../types'

/** 播放与下载都打这个地址，mp4 从不进 IndexedDB。 */
export function videoOutputUrl(task: VideoTask): string | null {
  if (!task.bffRequestId || task.outputIndex === undefined) return null
  return `${bffBaseUrl()}/v1/queue/requests/${task.bffRequestId}/output/${task.outputIndex}`
}
