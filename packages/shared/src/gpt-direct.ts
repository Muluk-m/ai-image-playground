import { imageSizeTier, parseImageSize } from './image'
import { nearestImageSize } from './image-parameters'

/**
 * 可以走 OpenAI 直连的 GPT Image 模型。另一条路是 sub2api：它忽略 size 与 quality，一律出约
 * 1.57MP 一档，所以 2K、4K 与高画质只有直连兑现得了，只开给会员。
 */
export const GPT_DIRECT_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const

export function isGptDirectModel(model: string): boolean {
  return (GPT_DIRECT_MODELS as readonly string[]).includes(model)
}

/** 档位与计价看的参数。带遮罩的局部编辑尺寸跟着原图走、不是用户选的档位，一律按 1K 计。 */
export interface GptTierInput {
  size?: string
  quality?: string
  mask?: unknown
}

function tierOf(input: GptTierInput) {
  return input.mask ? '1K' : imageSizeTier(input.size)
}

/** 非会员能提交的参数：1K 档、非高画质（sub2api 就出这一档）。 */
export function isGptBasicRequest(input: GptTierInput): boolean {
  return tierOf(input) === '1K' && input.quality !== 'high'
}

const BASIC_MAX_PIXELS = 1_572_864

/**
 * 把参数收到非会员那一档：超过 1K 的尺寸按原比例缩到 1K 以内（宽高取 16 的倍数），高画质改 medium。
 * 不是 GPT 直连模型、或本来就在这一档的原样返回。
 */
export function clampGptBasicRequest<T extends GptTierInput>(model: string, request: T): T {
  if (!isGptDirectModel(model) || isGptBasicRequest(request)) return request
  let size = request.size
  const parsed = size && !request.mask ? parseImageSize(size) : null
  if (parsed && parsed.width * parsed.height > BASIC_MAX_PIXELS) {
    const scale = Math.sqrt(BASIC_MAX_PIXELS / (parsed.width * parsed.height))
    const floor16 = (value: number) => Math.max(16, Math.floor((value * scale) / 16) * 16)
    size = `${floor16(parsed.width)}x${floor16(parsed.height)}`
  }
  const quality = request.quality === 'high' ? 'medium' : request.quality
  return {
    ...request,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {}),
  }
}

/**
 * 每张图按档位与画质的积分倍率，以 1K medium 为 1。2026-10-31 直连实测输出 token（两个模型相同）：
 * 1K 196/439/1756、2K 397/892/3568、4K(3840x2160) 371/865/3336（low/medium/high）。
 * 低画质不打折；auto 与没写按 medium 计（直连把 auto 改发 medium，成本才有上限）。
 */
const GPT_IMAGE_MULTIPLIERS = {
  '1K': { low: 1, medium: 1, high: 4 },
  '2K': { low: 1, medium: 2, high: 8 },
  '4K': { low: 1, medium: 2, high: 8 },
} as const

export function gptImageRateMultiplier(model: string, request: GptTierInput): number {
  if (!isGptDirectModel(model)) return 1
  const { quality } = request
  const level = quality === 'low' || quality === 'high' ? quality : 'medium'
  return GPT_IMAGE_MULTIPLIERS[tierOf(request)][level]
}

/**
 * 图片扣费看的请求。Gemini 用 `image_size`（队列）或 `gemini_image_size`（输入框 / 轮参数）；
 * 两者都有时以队列字段为准。不读上游回图的像素：`size=auto` 曾回过比 1K 上限更大的图。
 */
export interface ImageRateRequest extends GptTierInput {
  image_size?: string
  gemini_image_size?: string
}

/**
 * 与目录 `pricing.tierMultiplier` 相同。手写在这里，计价不跟随 Grok 等尚未启用的目录倍率。
 * 4K 已定义，渠道尚未开放。
 */
const GEMINI_TIER_MULTIPLIERS = {
  'gemini-nano-banana-2.1': { '1K': 1, '2K': 1.5, '4K': 3.4 },
  'gemini-3-pro-image': { '1K': 1, '2K': 1, '4K': 1.8 },
} as const

const RATE_TIERS = ['1K', '2K', '4K'] as const
type RateTier = (typeof RATE_TIERS)[number]

function asRateTier(value: string | undefined): RateTier | undefined {
  return value === '1K' || value === '2K' || value === '4K' ? value : undefined
}

/**
 * 请求档。渠道声明了可出的档、且请求档不在其中时，收到声明里最近的一档再计价
 * （与 Vertex 发出前的 `nearestImageSize` 同一规则）。没声明就按请求档，不看回图像素。
 */
function billableImageTier(
  request: ImageRateRequest,
  supportedTiers?: readonly string[],
): RateTier | undefined {
  const requested = asRateTier(request.image_size ?? request.gemini_image_size)
  if (!requested || !supportedTiers?.length) return requested
  const allowed = supportedTiers.filter((tier): tier is RateTier => asRateTier(tier) === tier)
  if (!allowed.length || allowed.includes(requested)) return requested
  return asRateTier(nearestImageSize(requested, allowed))
}

/**
 * 每张图的积分倍率，乘在价目表单价上，再由 `ceil(单价 × 张数 × 倍率)` 取整。
 * GPT 直连仍按档位 × 画质；Nano 2.1 / Pro 按可出的请求档；没写档位、认不出的档、以及其余模型为 1。
 */
export function imageRateMultiplier(
  model: string,
  request: ImageRateRequest,
  supportedTiers?: readonly string[],
): number {
  if (isGptDirectModel(model)) return gptImageRateMultiplier(model, request)
  const table = GEMINI_TIER_MULTIPLIERS[model as keyof typeof GEMINI_TIER_MULTIPLIERS]
  const tier = billableImageTier(request, supportedTiers)
  if (!table || !tier) return 1
  return table[tier]
}

/**
 * 智能体、阶段授权、批量与预先准备的提交会先把 GPT 收到基础档（`basicGptInput` /
 * `clampGptBasicRequest`），再计价。提案冻结的倍率必须走这里，和提交时的 `pricingOf` 一致。
 * 网站直接提交不要用它：会员的 GPT 档位原样计价。
 * PR-M 若改基础档收口，这里必须跟 `basicGptInput` 用同一个函数，否则授权倍率与实扣对不上。
 * `supportedTiers` 是渠道声明的可出档；提案和提交要传同一份。
 */
export function preparedImageRateMultiplier(
  model: string,
  request: ImageRateRequest,
  supportedTiers?: readonly string[],
): number {
  return imageRateMultiplier(model, clampGptBasicRequest(model, request), supportedTiers)
}
