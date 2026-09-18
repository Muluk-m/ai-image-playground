import type {
  VideoAspectRatio,
  VideoDeriveMode,
  VideoDuration,
  VideoResolution,
} from '@image-playground/shared'

/**
 * 旧导演台的一条视频任务。导演台已下线，这些记录只留在浏览器本地库里，读来计算图片引用；
 * 不再新建、不再轮询。
 */
export interface VideoTask {
  id: string
  bffRequestId?: string
  clientRequestId: string
  channelId: string
  source: 'text' | 'image'
  prompt: string
  model: string
  duration: number
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId?: string
  lastFrameImageId?: string
  derived?: { mode: VideoDeriveMode; sourceTaskId: string }
  status: 'queued' | 'running' | 'done' | 'error'
  error: string | null
  credits?: number
  outputIndex?: number
  width?: number
  height?: number
  createdAt: number
  completedAt: number | null
  thumbnailDataUrl?: string
  storyboardId?: string
  shotNo?: number
}

/** 画布生成视频的参数草稿。 */
export interface VideoDraft {
  model: string
  duration: VideoDuration
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
}
