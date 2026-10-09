import { formatImageRatio, parseImageSize } from '@image-playground/shared'

export { nearestAspectRatio } from '@image-playground/shared'

const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/
const SIZE_MULTIPLE = 16
const MAX_EDGE = 3840
const MAX_ASPECT_RATIO = 3
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400
const MAX_1K_PIXELS = 1_572_864

export type SizeTier = '1K' | '2K' | '4K'
type PresetRatio = '1:1' | '3:2' | '2:3' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9'

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function floorToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function ceilToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}

function normalizeDimensions(width: number, height: number) {
  let normalizedWidth = roundToMultiple(width, SIZE_MULTIPLE)
  let normalizedHeight = roundToMultiple(height, SIZE_MULTIPLE)

  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = floorToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = ceilToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  for (let i = 0; i < 4; i++) {
    const maxEdge = Math.max(normalizedWidth, normalizedHeight)
    if (maxEdge > MAX_EDGE) {
      scaleToFit(MAX_EDGE / maxEdge)
    }

    if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) {
      normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    } else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) {
      normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    }

    const pixels = normalizedWidth * normalizedHeight
    if (pixels > MAX_PIXELS) {
      scaleToFit(Math.sqrt(MAX_PIXELS / pixels))
    } else if (pixels < MIN_PIXELS) {
      scaleToFill(Math.sqrt(MIN_PIXELS / pixels))
    }
  }

  return { width: normalizedWidth, height: normalizedHeight }
}

export function normalizeImageSize(size: string) {
  const trimmed = size.trim()
  const parsed = parseImageSize(trimmed)
  if (!parsed) return trimmed

  const { width, height } = normalizeDimensions(parsed.width, parsed.height)
  return `${width}x${height}`
}

/** Codex CLI 只接受到 1K 的分辨率：超出 1K 像素预算时按同一比例回落到 1K 档。 */
export function normalizeCodexCliImageSize(size: string) {
  const trimmed = size.trim()
  const parsed = parseImageSize(trimmed)
  if (!parsed) return trimmed

  const { width, height } = normalizeDimensions(parsed.width, parsed.height)
  const normalized = `${width}x${height}`
  if (width * height <= MAX_1K_PIXELS) return normalized

  return calculateImageSize('1K', `${width}:${height}`) ?? normalized
}

export function parseRatio(ratio: string) {
  const match = ratio.match(RATIO_PATTERN)
  if (!match) return null

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

export function sizeRatioLabel(size: string): string {
  const parsed = parseImageSize(size)
  if (!parsed) return 'auto'

  const label = formatImageRatio(parsed.width, parsed.height).replace(/^≈/, '')
  return label || 'auto'
}

export function sameAspectRatio(a: string, b: string): boolean {
  const first = parseImageSize(a)
  const second = parseImageSize(b)
  if (!first || !second) return false

  if (first.width <= 0 || first.height <= 0 || second.width <= 0 || second.height <= 0) {
    return false
  }

  const firstRatio = first.width / first.height
  const secondRatio = second.width / second.height
  // 上游会重新量化像素数（如 1024x1824 变成 941x1672），但比例不变；只有构图比例变化才算不一致。
  return Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio) <= 0.03
}

/**
 * 每个档位的像素预算上限。
 * 在该预算内、满足所有 OpenAI 约束的前提下，选取总像素最大的候选尺寸。
 */
const TIER_PIXEL_BUDGET: Record<SizeTier, number> = {
  '1K': MAX_1K_PIXELS, // 1024 × 1536
  '2K': 4_194_304, // 2048 × 2048
  '4K': MAX_PIXELS, // 3840 × 2160
}

/**
 * 常用比例优先使用官方示例或通用显示标准，避免按像素预算计算出不常见尺寸。
 * 其中 21:9 的常见显示器尺寸会按 16 倍数约束做轻微规整。
 */
const COMMON_SIZE_PRESETS: Record<SizeTier, Record<PresetRatio, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '21:9': '1280x544',
  },
  '2K': {
    '1:1': '2048x2048',
    '3:2': '2160x1440',
    '2:3': '1440x2160',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '21:9': '2560x1088',
  },
  '4K': {
    '1:1': '2880x2880',
    '3:2': '3456x2304',
    '2:3': '2304x3456',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '4:3': '3200x2400',
    '3:4': '2400x3200',
    '21:9': '3840x1600',
  },
}

/** 把「宽:高」约到最简；非整数比例原样拼回。 */
export function reduceRatio(width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return `${width}:${height}`
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function getPresetRatioKey(ratioWidth: number, ratioHeight: number): PresetRatio | null {
  if (!Number.isInteger(ratioWidth) || !Number.isInteger(ratioHeight)) return null
  const key = reduceRatio(ratioWidth, ratioHeight)
  return key in COMMON_SIZE_PRESETS['1K'] ? (key as PresetRatio) : null
}

const MAX_RATIO_ERROR = 0.01

export function calculateImageSize(tier: SizeTier, ratio: string) {
  const parsed = parseRatio(ratio)
  if (!parsed) return null

  const { width: ratioWidth, height: ratioHeight } = parsed
  const presetRatioKey = getPresetRatioKey(ratioWidth, ratioHeight)
  if (presetRatioKey) return COMMON_SIZE_PRESETS[tier][presetRatioKey]

  const unclampedTargetRatio = ratioWidth / ratioHeight
  const targetRatio = Math.min(
    MAX_ASPECT_RATIO,
    Math.max(1 / MAX_ASPECT_RATIO, unclampedTargetRatio),
  )
  const pixelBudget = TIER_PIXEL_BUDGET[tier]

  let bestWidth = 0
  let bestHeight = 0
  let bestPixels = 0

  for (let w = SIZE_MULTIPLE; w <= MAX_EDGE; w += SIZE_MULTIPLE) {
    const idealH = w / targetRatio
    // 尝试 floor 和 ceil 对齐到 16 的倍数，取像素更大且合法的那个
    const candidates = [
      Math.floor(idealH / SIZE_MULTIPLE) * SIZE_MULTIPLE,
      Math.ceil(idealH / SIZE_MULTIPLE) * SIZE_MULTIPLE,
    ]

    for (const h of candidates) {
      if (h < SIZE_MULTIPLE || h > MAX_EDGE) continue

      const pixels = w * h
      if (pixels > pixelBudget || pixels < MIN_PIXELS) continue
      if (Math.max(w / h, h / w) > MAX_ASPECT_RATIO) continue

      const actualRatio = w / h
      const ratioError = Math.abs(actualRatio - targetRatio) / targetRatio
      if (ratioError > MAX_RATIO_ERROR) continue

      if (pixels > bestPixels) {
        bestPixels = pixels
        bestWidth = w
        bestHeight = h
      }
    }
  }

  if (bestPixels === 0) return null
  return `${bestWidth}x${bestHeight}`
}

export const SIZE_TIERS: readonly SizeTier[] = ['1K', '2K', '4K']

/** 生成设置里的预设比例，按「方 → 竖 → 横」排，和比例宫格从左到右一致。 */
export const PRESET_RATIOS: readonly PresetRatio[] = [
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '21:9',
]

/** 预设尺寸 → 档位与比例，回显时一次查表。 */
const PRESET_BY_SIZE = new Map(
  SIZE_TIERS.flatMap((tier) =>
    PRESET_RATIOS.map((ratio) => [COMMON_SIZE_PRESETS[tier][ratio], { tier, ratio }] as const),
  ),
)

/** `params.size` 在设置卡片里对应哪一格。 */
export type SizeSelection =
  | { kind: 'auto' }
  | { kind: 'preset'; ratio: PresetRatio; tier: SizeTier }
  /** 预设外的尺寸或比例：`ratio` 用来画形状。 */
  | { kind: 'custom'; ratio: string }

export interface SizeRules {
  /** 模型只认比例，不承诺像素：分辨率档不出现。 */
  ratioOnly: boolean
  /** Codex CLI 只到 1K。 */
  limitTo1K: boolean
}

/** 只认比例或限 1K 时，上游会重新量化像素，只能按比例对上预设、按 1K 写回。 */
const byRatio = (rules: SizeRules) => rules.ratioOnly || rules.limitTo1K

export function readSizeSelection(size: string, rules: SizeRules): SizeSelection {
  if (!size || size === 'auto') return { kind: 'auto' }

  const pixels = parseImageSize(size)
  if (!pixels) {
    // 只认比例的模型存的就是「3:4」这种比例本身。
    const parsed = parseRatio(size)
    if (!parsed) return { kind: 'auto' }
    const preset = getPresetRatioKey(parsed.width, parsed.height)
    return preset
      ? { kind: 'preset', ratio: preset, tier: '1K' }
      : { kind: 'custom', ratio: reduceRatio(parsed.width, parsed.height) }
  }

  if (byRatio(rules)) {
    const ratio = PRESET_RATIOS.find((one) => sameAspectRatio(size, COMMON_SIZE_PRESETS['1K'][one]))
    if (ratio) return { kind: 'preset', ratio, tier: '1K' }
  } else {
    const preset = PRESET_BY_SIZE.get(normalizeImageSize(size))
    if (preset) return { kind: 'preset', ...preset }
  }
  return { kind: 'custom', ratio: reduceRatio(pixels.width, pixels.height) }
}

export function normalizeSizeFor(size: string, rules: SizeRules) {
  return rules.limitTo1K ? normalizeCodexCliImageSize(size) : normalizeImageSize(size)
}

/** 选中一格比例或一档分辨率后要写回的尺寸。 */
export function sizeFor(tier: SizeTier, ratio: string, rules: SizeRules): string | null {
  const size = calculateImageSize(byRatio(rules) ? '1K' : tier, ratio)
  return size ? normalizeSizeFor(size, rules) : null
}
