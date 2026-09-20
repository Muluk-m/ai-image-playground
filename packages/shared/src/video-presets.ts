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

/** 新建一条视频时的缺省档位；模型不支持就按它自己的支持矩阵退档。 */
export const VIDEO_DEFAULT_DURATION: VideoDuration = 5
export const VIDEO_DEFAULT_ASPECT_RATIO: VideoAspectRatio = '16:9'
export const VIDEO_DEFAULT_RESOLUTION: VideoResolution = '720p'

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
  /** 参考图在 `input_images` 里的下标，按用户排好的顺序；不与首尾帧重叠。只用于 generate。 */
  reference_image_indices?: number[]
  /** 默认 generate；extend 从源片最后一帧续写，edit 按提示词改源片。 */
  mode?: VideoMode
  /** 源片：本人已完成的视频任务及其输出下标。extend / edit 必填。 */
  source_task_id?: string
  source_output_index?: number
}

/** 模型能带几张参考图（全能参考）：主体、道具、场景各一张，由提示词说明怎么用。 */
export interface VideoReferenceSupport {
  readonly max: number
  /** 带参考图时的清晰度上限；上游在这个模式下不出更高的。 */
  readonly maxResolution: VideoResolution
  /** 能否同时带首尾帧。 */
  readonly withFrames: boolean
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
  /** 缺省即不支持参考图。 */
  readonly referenceImages?: VideoReferenceSupport
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
    // 只有 1.5 接参考图，BFF 带参考图时切到它；它在这个模式下封顶 720p。
    referenceImages: { max: 7, maxResolution: '720p', withFrames: true },
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
    // 方舟全模态参考：图片 0~9 张；Mini 只出到 720p；首尾帧是另一种模式，不与参考图同用。
    referenceImages: { max: 9, maxResolution: '720p', withFrames: false },
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

/** 一条驳回一个 code。`reason` 是给 BFF 的中文回执，`code` 才是界面查译文用的键。 */
export type VideoRejectionCode =
  | 'promptTooLong'
  | 'modelUnsupported'
  | 'modeUnsupported'
  | 'durationUnsupported'
  | 'extendDurationOutOfRange'
  | 'editDurationMissing'
  | 'aspectRatioUnsupported'
  | 'resolutionUnsupported'
  | 'durationForResolutionUnsupported'
  | 'frameUnsupported'
  | 'frameImageMissing'
  | 'deriveModeUnsupported'
  | 'deriveFramesRejected'
  | 'deriveSourceMissing'
  | 'referenceUnsupported'
  | 'referenceTooMany'
  | 'referenceResolutionUnsupported'
  | 'referenceFramesRejected'
  | 'referenceImageMissing'

/**
 * 渲染驳回文案要的原始数据。这里一律不放译好的词 —— 首帧/尾帧、续写/改视频只给枚举值，
 * 由界面自己查译文，否则英文界面会渲染出夹着中文的句子。
 */
export interface VideoRejectionParams {
  /** 模型的用户可读名，本来就是英文或品牌名。 */
  readonly label?: string
  readonly min?: number
  readonly max?: number
  /** 已经 join 好的时长列表，例如 `5 / 8 / 10`。 */
  readonly durations?: string
  /** 已经 join 好的允许值列表：画幅或清晰度。 */
  readonly allowed?: string
  readonly resolution?: string
  readonly frame?: 'first' | 'last'
  readonly mode?: VideoDeriveMode
}

export interface VideoRejection {
  readonly code: VideoRejectionCode
  readonly params: VideoRejectionParams
  /** 中文回执，BFF 直接当错误消息返回；界面不要渲染它。 */
  readonly reason: string
}

const FRAME_NAMES: Record<'first' | 'last', string> = { first: '首帧', last: '尾帧' }

function rejection(
  code: VideoRejectionCode,
  params: VideoRejectionParams,
  reason: string,
): VideoRejection {
  return { code, params, reason }
}

/** 驳回对象压回 BFF 认识的窄形状；`packages/shared` 之外只有 BFF 该用它。 */
function toValidationResult(found: VideoRejection | null): VideoValidationResult {
  return found ? { ok: false, reason: found.reason } : { ok: true }
}

/** 落不到该模型的合法档位上就退到它的第一档。 */
export function clampToSupported<T>(allowed: readonly T[], value: T): T {
  return allowed.includes(value) ? value : allowed[0]!
}

export interface VideoPreset {
  readonly duration: VideoDuration
  readonly aspectRatio: VideoAspectRatio
  readonly resolution: VideoResolution
}

/**
 * 把要的档位落到该模型支持得了的值上。清晰度是主轴：时长按清晰度退，
 * 反过来会把刚选定的清晰度顶掉。
 */
export function clampVideoPreset(
  support: VideoModelSupport,
  asked: {
    readonly duration?: number | undefined
    readonly aspectRatio?: VideoAspectRatio | undefined
    readonly resolution?: VideoResolution | undefined
  },
): VideoPreset {
  const resolution = clampToSupported(
    support.resolutions,
    asked.resolution ?? VIDEO_DEFAULT_RESOLUTION,
  )
  return {
    resolution,
    duration: clampToSupported(
      videoDurationsForResolution(support, resolution),
      (asked.duration ?? VIDEO_DEFAULT_DURATION) as VideoDuration,
    ),
    aspectRatio: clampToSupported(
      support.aspectRatios,
      asked.aspectRatio ?? VIDEO_DEFAULT_ASPECT_RATIO,
    ),
  }
}

/** 退档动了哪一项。字段名与 `VideoPreset` 同名，调用方不用再翻一次。 */
export type VideoPresetField = keyof VideoPreset

/** 一项明说了却落不到该模型合法档位上的约束。 */
export interface VideoPresetConflict {
  readonly field: VideoPresetField
  /** 要的那个值，原样回给调用方——说清楚「要的是什么」靠它。 */
  readonly asked: string | number
  /** 退档之后真会用的值。 */
  readonly used: string | number
  /** 这个模型在这一项上支持的全部值。 */
  readonly supported: readonly (string | number)[]
  /** 只有时长有：`supported` 是这个清晰度下的档位（见 `durationsByResolution`）。 */
  readonly resolution?: VideoResolution
}

/**
 * `clampVideoPreset` 的诚实版本：明说了却做不到的那几项。**没填的项不算**——按默认退档
 * 不是丢掉用户的约束，把它也报出来只会让调用方为每一次生成都道歉一遍。
 *
 * 用的是 `clampVideoPreset` 本身，所以「会退成什么」两处永远是同一个答案。
 */
export function videoPresetConflicts(
  support: VideoModelSupport,
  asked: {
    readonly duration?: number | undefined
    readonly aspectRatio?: VideoAspectRatio | undefined
    readonly resolution?: VideoResolution | undefined
  },
): VideoPresetConflict[] {
  const used = clampVideoPreset(support, asked)
  const conflicts: VideoPresetConflict[] = []
  if (asked.duration !== undefined && asked.duration !== used.duration)
    conflicts.push({
      field: 'duration',
      asked: asked.duration,
      used: used.duration,
      // 时长的可选项跟着清晰度走，所以报的是「真会用的那个清晰度」下的档位：
      // 报模型的全部时长，等于把用户导向另一个同样做不到的值。
      supported: videoDurationsForResolution(support, used.resolution),
      resolution: used.resolution,
    })
  if (asked.resolution !== undefined && asked.resolution !== used.resolution)
    conflicts.push({
      field: 'resolution',
      asked: asked.resolution,
      used: used.resolution,
      supported: support.resolutions,
    })
  if (asked.aspectRatio !== undefined && asked.aspectRatio !== used.aspectRatio)
    conflicts.push({
      field: 'aspectRatio',
      asked: asked.aspectRatio,
      used: used.aspectRatio,
      supported: support.aspectRatios,
    })
  return conflicts
}

export function videoRateMultiplier(modelId: string, resolution: VideoResolution): number {
  return VIDEO_MODEL_SUPPORT[modelId]?.resolutionMultipliers[resolution] ?? 1
}

export function videoDurationsForResolution(
  support: VideoModelSupport,
  resolution: VideoResolution,
): readonly VideoDuration[] {
  return support.durationsByResolution?.[resolution] ?? support.durations
}

export function validateVideoPrompt(modelId: string, prompt: string): VideoValidationResult {
  return toValidationResult(videoPromptRejection(modelId, prompt))
}

export function videoPromptRejection(modelId: string, prompt: string): VideoRejection | null {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  const max = support?.promptMaxChars
  if (max === undefined || prompt.length <= max) return null
  const { label } = support
  return rejection('promptTooLong', { label, max }, `${label} 描述最多 ${max} 字`)
}

export function validateVideoRequest(
  modelId: string,
  video: VideoRequest,
  inputImageCount: number,
): VideoValidationResult {
  return toValidationResult(videoRequestRejection(modelId, video, inputImageCount))
}

export function videoRequestRejection(
  modelId: string,
  video: VideoRequest,
  inputImageCount: number,
): VideoRejection | null {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  if (!support) return rejection('modelUnsupported', {}, '该模型不支持视频生成')

  const { label } = support
  const mode = video.mode ?? 'generate'
  if (!VIDEO_MODES.includes(mode)) return rejection('modeUnsupported', {}, '不支持的视频模式')
  const sourceCheck = videoSourceRejection(support, mode, video)
  if (sourceCheck) return sourceCheck

  if (mode === 'generate') {
    if (!(support.durations as readonly number[]).includes(video.duration_seconds)) {
      const durations = support.durations.join(' / ')
      return rejection(
        'durationUnsupported',
        { label, durations },
        `${label} 时长只支持 ${durations} 秒`,
      )
    }
  } else if (mode === 'extend') {
    const { duration_seconds: seconds } = video
    if (
      !Number.isInteger(seconds) ||
      seconds < VIDEO_EXTEND_MIN_SECONDS ||
      seconds > VIDEO_EXTEND_MAX_SECONDS
    )
      return rejection(
        'extendDurationOutOfRange',
        { min: VIDEO_EXTEND_MIN_SECONDS, max: VIDEO_EXTEND_MAX_SECONDS },
        `续写时长只支持 ${VIDEO_EXTEND_MIN_SECONDS}-${VIDEO_EXTEND_MAX_SECONDS} 秒`,
      )
  } else if (!(video.duration_seconds > 0)) {
    return rejection('editDurationMissing', {}, '改视频缺少源片时长')
  }

  if (!support.aspectRatios.includes(video.aspect_ratio)) {
    const allowed = support.aspectRatios.join(' / ')
    return rejection('aspectRatioUnsupported', { label, allowed }, `${label} 画幅只支持 ${allowed}`)
  }

  if (!support.resolutions.includes(video.resolution)) {
    const allowed = support.resolutions.map((r) => VIDEO_RESOLUTION_LABELS[r]).join(' / ')
    return rejection(
      'resolutionUnsupported',
      { label, allowed },
      `${label} 清晰度只支持 ${allowed}`,
    )
  }

  if (mode === 'generate') {
    const supported = videoDurationsForResolution(support, video.resolution)
    if (!(supported as readonly number[]).includes(video.duration_seconds)) {
      const resolution = VIDEO_RESOLUTION_LABELS[video.resolution]
      const durations = supported.join(' / ')
      return rejection(
        'durationForResolutionUnsupported',
        { label, resolution, durations },
        `${label} ${resolution} 只支持 ${durations} 秒`,
      )
    }
  }

  const frames = [
    { index: video.first_frame_index, supported: support.firstFrame, frame: 'first' },
    { index: video.last_frame_index, supported: support.lastFrame, frame: 'last' },
  ] as const
  for (const { index, supported, frame } of frames) {
    if (index === undefined) continue
    if (!supported)
      return rejection('frameUnsupported', { label, frame }, `${label} 不支持${FRAME_NAMES[frame]}`)
    if (!Number.isInteger(index) || index < 0 || index >= inputImageCount)
      return rejection('frameImageMissing', { frame }, `${FRAME_NAMES[frame]}图片不存在`)
  }

  return referenceRejection(support, video, inputImageCount)
}

function referenceRejection(
  support: VideoModelSupport,
  video: VideoRequest,
  inputImageCount: number,
): VideoRejection | null {
  const indices = video.reference_image_indices ?? []
  if (indices.length === 0) return null
  const { label } = support
  const references = support.referenceImages
  if (!references) return rejection('referenceUnsupported', { label }, `${label} 不支持参考图`)
  if (indices.length > references.max)
    return rejection(
      'referenceTooMany',
      { label, max: references.max },
      `${label} 最多 ${references.max} 张参考图`,
    )
  if (
    VIDEO_RESOLUTIONS.indexOf(video.resolution) >
    VIDEO_RESOLUTIONS.indexOf(references.maxResolution)
  ) {
    const resolution = VIDEO_RESOLUTION_LABELS[references.maxResolution]
    return rejection(
      'referenceResolutionUnsupported',
      { label, resolution },
      `${label} 带参考图时清晰度最高 ${resolution}`,
    )
  }
  const frames = [video.first_frame_index, video.last_frame_index].filter(
    (index) => index !== undefined,
  )
  if (frames.length > 0 && !references.withFrames)
    return rejection('referenceFramesRejected', { label }, `${label} 参考图不能与首尾帧同时使用`)
  const seen = new Set<number>(frames)
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= inputImageCount || seen.has(index))
      return rejection('referenceImageMissing', {}, '参考图不存在')
    seen.add(index)
  }
  return null
}

function videoSourceRejection(
  support: VideoModelSupport,
  mode: VideoMode,
  video: VideoRequest,
): VideoRejection | null {
  if (mode === 'generate') return null
  const { label } = support
  const name = VIDEO_DERIVE_LABELS[mode]
  if (!(mode === 'extend' ? support.extend : support.edit))
    return rejection('deriveModeUnsupported', { label, mode }, `${label} 不支持${name}`)
  if (
    video.first_frame_index !== undefined ||
    video.last_frame_index !== undefined ||
    (video.reference_image_indices?.length ?? 0) > 0
  )
    return rejection('deriveFramesRejected', {}, '续写和改视频不接受首尾帧或参考图')
  const index = video.source_output_index
  if (!video.source_task_id || index === undefined || !Number.isInteger(index) || index < 0)
    return rejection('deriveSourceMissing', { mode }, `${name}缺少源视频`)
  return null
}
