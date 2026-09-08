/**
 * 视频档位与每模型支持矩阵。价格结构与组合约束都长在模型上 — 计费预扣与前端估算
 * 都引用它，两边各写一份就会出现「按钮上写 A 积分、账单扣 B 积分」。
 */

export const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 15] as const
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

export const VIDEO_MODES = ['generate', 'extend', 'edit'] as const
export type VideoMode = (typeof VIDEO_MODES)[number]

/** 从一条成品视频派生出来的模式。 */
export type VideoDeriveMode = Exclude<VideoMode, 'generate'>

export const VIDEO_DERIVE_MODES = ['extend', 'edit'] as const satisfies readonly VideoDeriveMode[]

export const VIDEO_DERIVE_LABELS: Record<VideoDeriveMode, string> = {
  extend: '续写',
  edit: '改视频',
}

/** 续写长度的上下限（秒）。generate 的档位表不适用于它。 */
export const VIDEO_EXTEND_MIN_SECONDS = 2
export const VIDEO_EXTEND_MAX_SECONDS = 10

/** `SubmitRequest.video` 的载荷。首尾帧下标指向同一请求的 `input_images`。 */
export interface VideoRequest {
  /**
   * generate 走档位表；extend 是续写长度 2-10；edit 跟随源片，客户端填它已知的秒数。
   * 计费一律按这个数收。
   */
  duration_seconds: number
  aspect_ratio: VideoAspectRatio
  resolution: VideoResolution
  first_frame_index?: number
  last_frame_index?: number
  /** 默认 generate；extend 从源片最后一帧续写，edit 按提示词改源片。 */
  mode?: VideoMode
  /** 源片：本人已完成的视频任务及其输出下标。extend / edit 必填。 */
  source_task_id?: string
  source_output_index?: number
}

export interface VideoModelSupport {
  /** 出现在校验 reason 里的用户可读名。 */
  readonly label: string
  readonly durations: readonly VideoDuration[]
  readonly aspectRatios: readonly VideoAspectRatio[]
  readonly resolutions: readonly VideoResolution[]
  /** 每秒单价的清晰度倍率，逐条对应 `resolutions`。 */
  readonly resolutionMultipliers: Readonly<Partial<Record<VideoResolution, number>>>
  /** 某清晰度只配得上一部分时长；缺省为该模型的全部时长。 */
  readonly durationsByResolution?: Readonly<
    Partial<Record<VideoResolution, readonly VideoDuration[]>>
  >
  readonly firstFrame: boolean
  readonly lastFrame: boolean
  /** 从源片最后一帧续写。 */
  readonly extend: boolean
  /** 按提示词改写源片。 */
  readonly edit: boolean
  /** 上游按 token 限描述长度；这里按「一个汉字一个 token」的最坏情况折成字符数。缺省不限。 */
  readonly promptMaxChars?: number
  /** 实测典型耗时，用于生成中卡片的等待提示。 */
  readonly typicalSeconds: number
  /** 模型卡片上的一句话定位。耗时相近时推导不出区分度，所以显式写死。 */
  readonly tagline: string
}

export const VIDEO_MODEL_SUPPORT: Record<string, VideoModelSupport> = {
  'grok-imagine-video': {
    label: 'Grok',
    durations: [5, 8, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    resolutionMultipliers: { '720p': 1, '1080p': 1.6 },
    firstFrame: true,
    lastFrame: false,
    extend: true,
    edit: true,
    typicalSeconds: 40,
    tagline: '高清',
  },
  'agnes-video-2.5-flash': {
    label: 'Agnes 2.5 Flash',
    durations: [5, 8, 10],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p'],
    resolutionMultipliers: { '720p': 1 },
    firstFrame: true,
    lastFrame: true,
    extend: false,
    edit: false,
    typicalSeconds: 40,
    tagline: '首尾帧',
  },
  'doubao-seedance-2-0-mini-260615': {
    label: 'Seedance 2.0',
    durations: [5, 8, 10, 15],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    resolutionMultipliers: { '720p': 1, '1080p': 1.6 },
    firstFrame: true,
    lastFrame: true,
    extend: false,
    edit: false,
    typicalSeconds: 120,
    tagline: '多镜头',
  },
  'veo-3.1-fast-generate-preview': {
    label: 'Veo 3.1 Fast',
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    resolutionMultipliers: { '720p': 1, '1080p': 1.2 },
    durationsByResolution: { '1080p': [8] },
    promptMaxChars: 1024,
    firstFrame: true,
    lastFrame: false,
    extend: false,
    edit: false,
    typicalSeconds: 180,
    tagline: '原生音频',
  },
  'veo-3.1-lite-generate-preview': {
    label: 'Veo 3.1 Lite',
    durations: [4, 6, 8],
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    resolutionMultipliers: { '720p': 1, '1080p': 1.2 },
    durationsByResolution: { '1080p': [8] },
    promptMaxChars: 1024,
    firstFrame: true,
    lastFrame: false,
    extend: false,
    edit: false,
    typicalSeconds: 180,
    tagline: '经济档',
  },
}

export type VideoValidationResult = { ok: true } | { ok: false; reason: string }

export function videoRateMultiplier(modelId: string, resolution: VideoResolution): number {
  return VIDEO_MODEL_SUPPORT[modelId]?.resolutionMultipliers[resolution] ?? 1
}

export function videoDurationsForResolution(
  support: VideoModelSupport,
  resolution: VideoResolution,
): readonly VideoDuration[] {
  return support.durationsByResolution?.[resolution] ?? support.durations
}

/** 描述长度：上游按 token 限，前端与提交口用同一个字符数近似。 */
export function validateVideoPrompt(modelId: string, prompt: string): VideoValidationResult {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  const max = support?.promptMaxChars
  if (max === undefined || prompt.length <= max) return { ok: true }
  return { ok: false, reason: `${support.label} 描述最多 ${max} 字` }
}

export function validateVideoRequest(
  modelId: string,
  video: VideoRequest,
  inputImageCount: number,
): VideoValidationResult {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  if (!support) return { ok: false, reason: '该模型不支持视频生成' }

  const { label } = support
  const mode = video.mode ?? 'generate'
  if (!VIDEO_MODES.includes(mode)) return { ok: false, reason: '不支持的视频模式' }
  const sourceCheck = validateVideoSource(support, mode, video)
  if (sourceCheck) return sourceCheck

  if (mode === 'generate') {
    if (!(support.durations as readonly number[]).includes(video.duration_seconds))
      return { ok: false, reason: `${label} 时长只支持 ${support.durations.join(' / ')} 秒` }
  } else if (mode === 'extend') {
    const { duration_seconds: seconds } = video
    if (
      !Number.isInteger(seconds) ||
      seconds < VIDEO_EXTEND_MIN_SECONDS ||
      seconds > VIDEO_EXTEND_MAX_SECONDS
    )
      return {
        ok: false,
        reason: `续写时长只支持 ${VIDEO_EXTEND_MIN_SECONDS}-${VIDEO_EXTEND_MAX_SECONDS} 秒`,
      }
  } else if (!(video.duration_seconds > 0)) {
    return { ok: false, reason: '改视频缺少源片时长' }
  }

  if (!support.aspectRatios.includes(video.aspect_ratio))
    return { ok: false, reason: `${label} 画幅只支持 ${support.aspectRatios.join(' / ')}` }

  if (!support.resolutions.includes(video.resolution)) {
    const allowed = support.resolutions.map((r) => VIDEO_RESOLUTION_LABELS[r]).join(' / ')
    return { ok: false, reason: `${label} 清晰度只支持 ${allowed}` }
  }

  if (mode === 'generate') {
    const allowed = videoDurationsForResolution(support, video.resolution)
    if (!(allowed as readonly number[]).includes(video.duration_seconds))
      return {
        ok: false,
        reason: `${label} ${VIDEO_RESOLUTION_LABELS[video.resolution]} 只支持 ${allowed.join(' / ')} 秒`,
      }
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

function validateVideoSource(
  support: VideoModelSupport,
  mode: VideoMode,
  video: VideoRequest,
): VideoValidationResult | null {
  if (mode === 'generate') return null
  const name = VIDEO_DERIVE_LABELS[mode]
  if (!(mode === 'extend' ? support.extend : support.edit))
    return { ok: false, reason: `${support.label} 不支持${name}` }
  if (video.first_frame_index !== undefined || video.last_frame_index !== undefined)
    return { ok: false, reason: '续写和改视频不接受首尾帧' }
  const index = video.source_output_index
  if (!video.source_task_id || index === undefined || !Number.isInteger(index) || index < 0)
    return { ok: false, reason: `${name}缺少源视频` }
  return null
}
