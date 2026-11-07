import { imageSizeTier, parseImageSize } from './image'

/**
 * GPT Image 2.6 只走 OpenAI 直连，不进 2.5 的双通道，也不能换到别的模型。
 * 开关是 `GPT_IMAGE_26_ENABLED`（默认关），和 `GPT_DIRECT_ENABLED` 分开：
 * 现网直连是关的，2.6 不能跟着被静默送到 sub2api。
 */
export const GPT_IMAGE_26_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const

export type GptImage26Model = (typeof GPT_IMAGE_26_MODELS)[number]

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
 * 提交前的拒绝原因。返回 null 表示这单可以建任务、可以扣积分。
 * 尺寸乘帧数过线、编辑里要 GIF/SVG，都在扣积分之前 400。
 */
export function gptImage26Rejection(
  model: string,
  request: GptImage26QuoteInput & { n?: number; frame_duration_ms?: number },
  available: boolean,
): GptImage26Rejection | null {
  if (!isGptImage26Model(model)) return null
  if (!available) return 'unavailable'
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
    if (!Number.isInteger(duration) || duration < 20 || duration > 2000 || duration % 10 !== 0)
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
