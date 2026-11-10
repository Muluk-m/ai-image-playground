import { imageSizeTier, parseImageSize } from './image'

/**
 * GPT Image 2.6（flare / sunburst）。产品开关是 `GPT_IMAGE_26_ENABLED`（默认关），
 * 和 `GPT_DIRECT_ENABLED` 分开。直连 key 可用时仍只走 OpenAI 直连；直连没有启用 key、
 * 预算用尽或 key 被停用时，静态图改走 sub2api，上游模型名默认与产品 id 相同。
 * GIF / SVG 仍只要直连，直连不可用时拒绝，不改送到别的模型。
 */
export const GPT_IMAGE_26_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const

export type GptImage26Model = (typeof GPT_IMAGE_26_MODELS)[number]

/**
 * sub2api 与直连默认使用的上游模型名。只在这里声明；BFF 可用环境变量覆盖 sub2api 那一路。
 */
export const GPT_IMAGE_26_UPSTREAM_MODELS = {
  'gpt-image-2.6-flare': 'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst': 'gpt-image-2.6-sunburst',
} as const satisfies Record<GptImage26Model, string>

/** GIF 帧参数与 SVG 的 svg.model 只有 OpenAI 直连兑现。静态图可以走 sub2api。 */
export function gptImage26RequiresDirect(request: { output_format?: string }): boolean {
  return request.output_format === 'gif' || request.output_format === 'svg'
}

export function isGptImage26Model(model: string): model is GptImage26Model {
  return (GPT_IMAGE_26_MODELS as readonly string[]).includes(model)
}

/** 产品开放的 GIF 帧数。接口文档上限写法不一致（2–16 与 2–64），这里只放到 16。 */
export const GPT_IMAGE_26_GIF_FRAMES = [4, 6, 9, 12, 16] as const
export const GPT_IMAGE_26_GIF_FRAME_MIN = 2
export const GPT_IMAGE_26_GIF_FRAME_MAX = 16
/** 每帧时长，毫秒。界面三档：0.3 / 0.2 / 0.1 秒。 */
export const GPT_IMAGE_26_GIF_DURATIONS_MS = [300, 200, 100] as const
export const GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS = 200
/** 每帧时长的合法范围：20–2000 毫秒，步长 10。 */
export const GPT_IMAGE_26_GIF_DURATION_MIN_MS = 20
export const GPT_IMAGE_26_GIF_DURATION_MAX_MS = 2000
export const GPT_IMAGE_26_GIF_DURATION_STEP_MS = 10
export const GPT_IMAGE_26_GIF_SIZES = ['512x512', '768x768'] as const
/** 网站切到 GIF 与插件不传帧参数时的默认值，两端共用。 */
export const GPT_IMAGE_26_GIF_DEFAULT_FRAMES = 6
export const GPT_IMAGE_26_GIF_DEFAULT_SIZE = '768x768'
/** 产品雪碧图长边限制，不代表兼容渠道已确认的上游上限。 */
export const GPT_IMAGE_26_GIF_SPRITE_MAX_EDGE = 3840
/** 实测能拼进雪碧图的最大单帧边。超过它时按「边长 × 帧数 > 3840」拒绝。 */
export const GPT_IMAGE_26_GIF_MEASURED_EDGE = 768
/** 以 768×768、12 帧成功设置为保守产品预算；3072×3072 已被拒，上游精确像素上限未知。 */
const GIF_SPRITE_PIXEL_BUDGET = 768 * 768 * 12

export const GPT_IMAGE_26_SVG_CREDITS = 610

/** 静态图积分。基准是 2.5 Flare 1K 标准 = 100。4K 与 2K 同价。 */
const STILL_CREDITS = {
  '1K': { low: 190, medium: 330, high: 400 },
  '2K': { low: 380, medium: 670, high: 810 },
  '4K': { low: 380, medium: 670, high: 810 },
} as const

/** 编辑相对同档生成价的倍数：1K 标准 390/330，取整到 10。含 1 张参考图。 */
const EDIT_NUMERATOR = 390
const EDIT_DENOMINATOR = 330
const EXTRA_REFERENCE_CREDITS = 60

export interface GptImage26QuoteInput {
  size?: string
  quality?: string
  output_format?: string
  frame_count?: number
  mask?: unknown
  input_images?: readonly unknown[]
}

export function gifSpriteExceedsLimit(width: number, height: number, frames: number): boolean {
  if (!Number.isInteger(frames) || frames < GPT_IMAGE_26_GIF_FRAME_MIN) return true
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width % 16 !== 0 ||
    height % 16 !== 0
  )
    return true
  const edge = Math.max(width, height)
  if (edge > GPT_IMAGE_26_GIF_SPRITE_MAX_EDGE) return true
  if (edge / Math.min(width, height) > 3) return true
  // 1024×6 的长条雪碧图超过 3840，上游直接拒绝。768 及以下按实测能装进 3840 的格子里排。
  if (edge > GPT_IMAGE_26_GIF_MEASURED_EDGE && edge * frames > GPT_IMAGE_26_GIF_SPRITE_MAX_EDGE)
    return true
  const columns = Math.max(1, Math.ceil(Math.sqrt(frames)))
  const rows = Math.ceil(frames / columns)
  const spriteWidth = columns * width
  const spriteHeight = rows * height
  return (
    Math.max(spriteWidth, spriteHeight) > GPT_IMAGE_26_GIF_SPRITE_MAX_EDGE ||
    spriteWidth * spriteHeight > GIF_SPRITE_PIXEL_BUDGET
  )
}

function roundTo10(value: number): number {
  return Math.round(value / 10) * 10
}

function stillCredits(input: GptImage26QuoteInput): number {
  const tier = input.mask ? '1K' : imageSizeTier(input.size)
  const quality = input.quality === 'low' || input.quality === 'high' ? input.quality : 'medium'
  return STILL_CREDITS[tier][quality]
}

function referenceCount(input: GptImage26QuoteInput): number {
  const images = input.input_images?.length ?? 0
  if (images > 0) return images
  return input.mask ? 1 : 0
}

/** 一张产出的积分。flare 与 sunburst 同价。GIF / SVG 不随张数放大，调用方必须把 n 限制为 1。 */
export function gptImage26Credits(input: GptImage26QuoteInput): number {
  if (input.output_format === 'gif') {
    const frames = input.frame_count ?? GPT_IMAGE_26_GIF_DEFAULT_FRAMES
    if (frames <= 6) return 370
    if (frames <= 9) return 550
    return 980
  }
  if (input.output_format === 'svg') return GPT_IMAGE_26_SVG_CREDITS
  const generated = stillCredits(input)
  const refs = referenceCount(input)
  if (refs === 0) return generated
  const withOne = roundTo10((generated * EDIT_NUMERATOR) / EDIT_DENOMINATOR)
  return withOne + EXTRA_REFERENCE_CREDITS * (refs - 1)
}

/**
 * 相对「100 积分 = 倍率 1」的倍率，交给现有预扣（单价 × 倍率 × 张数）。
 * 私有单价表要把这两个模型登记成和 2.5 Flare 一样的 100 积分/张，倍率才等于上面的积分。
 */
export function gptImage26RateMultiplier(input: GptImage26QuoteInput): number {
  return gptImage26Credits(input) / 100
}

/** 界面上的预计秒数。来自 2026-11-05 实测；7–9 帧与 10–16 帧按产品原型的档。 */
export function gptImage26EtaSeconds(model: string, input: GptImage26QuoteInput): number {
  if (input.output_format === 'svg') return 32
  if (input.output_format === 'gif') {
    const frames = input.frame_count ?? GPT_IMAGE_26_GIF_DEFAULT_FRAMES
    if (frames <= 6) return 13
    if (frames <= 9) return 15
    return 25
  }
  if (referenceCount(input) > 0) return 21
  return model === 'gpt-image-2.6-sunburst' ? 21 : 7
}

export type GptImage26Rejection =
  | 'unavailable'
  | 'gif_edit'
  | 'svg_edit'
  | 'gif_count'
  | 'svg_count'
  | 'gif_frames'
  | 'gif_duration'
  | 'gif_sprite'
  | 'gif_size'

/**
 * 界面把没写的帧数和每帧时长显示成默认值。提交前补上同一组默认值，
 * 省略和点选默认档才会是同一单；已经写明的尺寸和帧数原样保留。
 */
export function withGptImage26GifDefaults<
  T extends GptImage26QuoteInput & { frame_duration_ms?: number },
>(request: T): T & { frame_count?: number; frame_duration_ms?: number; size?: string } {
  if (request.output_format !== 'gif') return request
  const frame_count = request.frame_count ?? GPT_IMAGE_26_GIF_DEFAULT_FRAMES
  const frame_duration_ms = request.frame_duration_ms ?? GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS
  const size = request.size ?? GPT_IMAGE_26_GIF_DEFAULT_SIZE
  if (
    frame_count === request.frame_count &&
    frame_duration_ms === request.frame_duration_ms &&
    size === request.size
  )
    return request
  return { ...request, frame_count, frame_duration_ms, size }
}

/** 拒绝原因对应的请求字段。日志只记这些名字，不记字段值。 */
export function gptImage26RejectionFields(reason: GptImage26Rejection): readonly string[] {
  switch (reason) {
    case 'unavailable':
      return []
    case 'gif_edit':
    case 'svg_edit':
      return ['output_format', 'input_images']
    case 'gif_count':
    case 'svg_count':
      return ['n', 'output_format']
    case 'gif_frames':
      return ['frame_count']
    case 'gif_duration':
      return ['frame_duration_ms']
    case 'gif_sprite':
      return ['size', 'frame_count']
    case 'gif_size':
      return ['size']
    default: {
      const unhandled: never = reason
      return unhandled
    }
  }
}

/**
 * 提交前的拒绝原因。返回 null 表示这单可以建任务、可以扣积分。
 * 尺寸乘帧数过线、编辑里要 GIF/SVG，都在扣积分之前 400。
 */
export function gptImage26Rejection(
  model: string,
  request: GptImage26QuoteInput & { n?: number; frame_duration_ms?: number },
  available: boolean,
): GptImage26Rejection | null {
  if (!isGptImage26Model(model)) return null
  // 直连不可用时静态图留给 sub2api。GIF / SVG 没有第二条路，在看帧数之前就拒绝。
  if (!available) return gptImage26RequiresDirect(request) ? 'unavailable' : null
  const format = request.output_format
  const editing = referenceCount(request) > 0
  const count = request.n ?? 1
  if (format === 'gif') {
    if (editing) return 'gif_edit'
    if (count !== 1) return 'gif_count'
    const frames = request.frame_count
    if (
      typeof frames !== 'number' ||
      !Number.isInteger(frames) ||
      frames < GPT_IMAGE_26_GIF_FRAME_MIN ||
      frames > GPT_IMAGE_26_GIF_FRAME_MAX
    )
      return 'gif_frames'
    const duration = request.frame_duration_ms ?? GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS
    if (
      !Number.isInteger(duration) ||
      duration < GPT_IMAGE_26_GIF_DURATION_MIN_MS ||
      duration > GPT_IMAGE_26_GIF_DURATION_MAX_MS ||
      duration % GPT_IMAGE_26_GIF_DURATION_STEP_MS !== 0
    )
      return 'gif_duration'
    const parsed = request.size ? parseImageSize(request.size) : null
    if (!parsed) return 'gif_size'
    if (gifSpriteExceedsLimit(parsed.width, parsed.height, frames)) return 'gif_sprite'
    return null
  }
  if (format === 'svg') {
    if (editing) return 'svg_edit'
    if (count !== 1) return 'svg_count'
    return null
  }
  return null
}
