/**
 * 视频档位与每模型支持矩阵。清晰度倍率只在这里定义一次 — 计费预扣与前端估算
 * 都引用它，两边各写一份就会出现「按钮上写 A 积分、账单扣 B 积分」。
 */

export const VIDEO_DURATIONS = [5, 8, 10] as const
export type VideoDuration = (typeof VIDEO_DURATIONS)[number]

export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number]

export const VIDEO_RESOLUTIONS = ['720p', '1080p', '2k'] as const
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

export const VIDEO_RESOLUTION_LABELS: Record<VideoResolution, string> = {
  '720p': '720p',
  '1080p': '1080p',
  '2k': '2K',
}

/** 每秒单价的清晰度倍率。 */
export const VIDEO_RESOLUTION_MULTIPLIERS: Record<VideoResolution, number> = {
  '720p': 1,
  '1080p': 1.6,
  '2k': 2.2,
}

/** `SubmitRequest.video` 的载荷。首尾帧下标指向同一请求的 `input_images`。 */
export interface VideoRequest {
  duration_seconds: VideoDuration
  aspect_ratio: VideoAspectRatio
  resolution: VideoResolution
  first_frame_index?: number
  last_frame_index?: number
}

export interface VideoModelSupport {
  /** 出现在校验 reason 里的用户可读名。 */
  readonly label: string
  readonly durations: readonly VideoDuration[]
  readonly aspectRatios: readonly VideoAspectRatio[]
  readonly resolutions: readonly VideoResolution[]
  readonly firstFrame: boolean
  readonly lastFrame: boolean
  /** 实测典型耗时，用于生成中卡片的等待提示。 */
  readonly typicalSeconds: number
}

export const VIDEO_MODEL_SUPPORT: Record<string, VideoModelSupport> = {
  'grok-imagine-video': {
    label: 'Grok',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    firstFrame: true,
    lastFrame: false,
    typicalSeconds: 40,
  },
  'agnes-video-2.5': {
    label: 'Agnes 2.5',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p', '2k'],
    firstFrame: true,
    lastFrame: true,
    typicalSeconds: 90,
  },
}

export type VideoValidationResult = { ok: true } | { ok: false; reason: string }

export function videoRateMultiplier(resolution: VideoResolution): number {
  return VIDEO_RESOLUTION_MULTIPLIERS[resolution]
}

export function validateVideoRequest(
  modelId: string,
  video: VideoRequest,
  inputImageCount: number,
): VideoValidationResult {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  if (!support) return { ok: false, reason: '该模型不支持视频生成' }

  const { label } = support
  if (!support.durations.includes(video.duration_seconds))
    return { ok: false, reason: `${label} 时长只支持 ${support.durations.join(' / ')} 秒` }

  if (!support.aspectRatios.includes(video.aspect_ratio))
    return { ok: false, reason: `${label} 画幅只支持 ${support.aspectRatios.join(' / ')}` }

  if (!support.resolutions.includes(video.resolution)) {
    const allowed = support.resolutions.map((r) => VIDEO_RESOLUTION_LABELS[r]).join(' / ')
    return { ok: false, reason: `${label} 清晰度只支持 ${allowed}` }
  }

  const frames = [
    { index: video.first_frame_index, supported: support.firstFrame, name: '首帧' },
    { index: video.last_frame_index, supported: support.lastFrame, name: '尾帧' },
  ]
  for (const frame of frames) {
    if (frame.index === undefined) continue
    if (!frame.supported) return { ok: false, reason: `${label} 不支持${frame.name}` }
    if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= inputImageCount)
      return { ok: false, reason: `${frame.name}图片不存在` }
  }

  return { ok: true }
}
