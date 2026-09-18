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
  /** BFF 队列的 request_id，刷新后续轮与播放地址都用它。 */
  bffRequestId?: string
  /** 幂等键。提交中刷新时带同一个重提，BFF 去重。 */
  clientRequestId: string
  /** 提交到哪条频道，重生成与续提交要它。 */
  channelId: string
  source: 'text' | 'image'
  prompt: string
  model: string
  /** generate 走档位表；续写填的是续写秒数，不一定落在档位上。 */
  duration: number
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId?: string
  lastFrameImageId?: string
  /** 缺席即普通生成。sourceTaskId 是本地任务 id，提交时才换成源片的 bffRequestId。 */
  derived?: { mode: VideoDeriveMode; sourceTaskId: string }
  status: 'queued' | 'running' | 'done' | 'error'
  error: string | null
  /** 提交前的估算积分，无计费时不写。 */
  credits?: number
  /** 完成时的输出下标；播放地址是 `/v1/queue/requests/{bffRequestId}/output/{outputIndex}`。 */
  outputIndex?: number
  /** 实际输出像素，完成时由队列输出元信息回填；上游不给就没有。 */
  width?: number
  height?: number
  createdAt: number
  completedAt: number | null
  /** 图生任务是首帧缩略图；文生任务由播放器首帧截图回填。 */
  thumbnailDataUrl?: string
  /** 由分镜的某一镜提交时带上。 */
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
