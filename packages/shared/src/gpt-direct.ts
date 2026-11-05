import { imageSizeTier, imageTierMaxPixels, parseImageSize } from './image'

/**
 * 可以走 OpenAI 直连的 GPT Image 模型。另一条路是 sub2api：它忽略 size 与 quality，一律出约
 * 1.57MP 一档。2K、4K 与高画质只有直连兑现得了。非会员可以提交到 2K、非高画质；4K 与高画质只开给会员。
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

/**
 * sub2api 能兑现的参数：1K、非高画质。选路和结算用这个。
 * 它不再表示「非会员可以提交」——那是 {@link isGptNonMemberRequest}。
 */
export function isGptSub2apiDeliverable(input: GptTierInput): boolean {
  return tierOf(input) === '1K' && input.quality !== 'high'
}

/**
 * 旧名。语义等于 {@link isGptSub2apiDeliverable}，不要拿它做会员门禁。
 * 保留是为了已经编进私有 overlay 的调用点还能编译。
 */
export function isGptBasicRequest(input: GptTierInput): boolean {
  return isGptSub2apiDeliverable(input)
}

/** 非会员能提交的参数：档位不超过 2K，且不是高画质。4K 与 high 仍要会员。 */
export function isGptNonMemberRequest(input: GptTierInput): boolean {
  const tier = tierOf(input)
  return (tier === '1K' || tier === '2K') && input.quality !== 'high'
}

/** OpenAI Images 的边长与像素下限，与 model-catalog 里 pixels wire 的 maxEdge / minPixels 一致。 */
const OPENAI_MAX_EDGE = 3840
const OPENAI_MIN_PIXELS = 655_360
const OPENAI_MULTIPLE = 16

function floorToMultiple(value: number): number {
  return Math.max(OPENAI_MULTIPLE, Math.floor(value / OPENAI_MULTIPLE) * OPENAI_MULTIPLE)
}

/**
 * 按原比例缩进 2K 档，宽高取 16 的倍数，并落在 OpenAI 的边长与像素限制里。
 * 2K 的像素上限来自 image.ts 的档位表。
 */
function scaleSizeToNonMemberTier(width: number, height: number): string {
  const maxPixels = imageTierMaxPixels('2K')
  let scale = 1
  const pixels = width * height
  if (pixels > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / pixels))
  if (width > OPENAI_MAX_EDGE) scale = Math.min(scale, OPENAI_MAX_EDGE / width)
  if (height > OPENAI_MAX_EDGE) scale = Math.min(scale, OPENAI_MAX_EDGE / height)
  let nextWidth = floorToMultiple(width * scale)
  let nextHeight = floorToMultiple(height * scale)
  while (nextWidth * nextHeight > maxPixels) {
    if (nextWidth >= nextHeight && nextWidth > OPENAI_MULTIPLE) nextWidth -= OPENAI_MULTIPLE
    else if (nextHeight > OPENAI_MULTIPLE) nextHeight -= OPENAI_MULTIPLE
    else break
  }
  if (nextWidth * nextHeight < OPENAI_MIN_PIXELS) {
    const grow = Math.sqrt(OPENAI_MIN_PIXELS / (nextWidth * nextHeight))
    const ceilToEdge = (value: number) =>
      Math.min(
        OPENAI_MAX_EDGE,
        Math.max(OPENAI_MULTIPLE, Math.ceil((value * grow) / OPENAI_MULTIPLE) * OPENAI_MULTIPLE),
      )
    nextWidth = ceilToEdge(nextWidth)
    nextHeight = ceilToEdge(nextHeight)
    while (nextWidth * nextHeight > maxPixels) {
      if (nextWidth >= nextHeight && nextWidth > OPENAI_MULTIPLE) nextWidth -= OPENAI_MULTIPLE
      else if (nextHeight > OPENAI_MULTIPLE) nextHeight -= OPENAI_MULTIPLE
      else break
    }
  }
  return `${nextWidth}x${nextHeight}`
}

/**
 * 把参数收到非会员那一档：超过 2K 的尺寸按原比例缩到 2K 以内（宽高取 16 的倍数，
 * 边长 ≤3840、像素 ≥655,360），高画质改 medium。
 * 不是 GPT 直连模型、或本来就在这一档的原样返回。重复收结果不变，准备时与提交时的哈希一致。
 */
export function clampGptNonMemberRequest<T extends GptTierInput>(model: string, request: T): T {
  if (!isGptDirectModel(model) || isGptNonMemberRequest(request)) return request
  let size = request.size
  const parsed = size && !request.mask ? parseImageSize(size) : null
  if (parsed) size = scaleSizeToNonMemberTier(parsed.width, parsed.height)
  const quality = request.quality === 'high' ? 'medium' : request.quality
  if (size === request.size && quality === request.quality) return request
  return {
    ...request,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {}),
  }
}

/**
 * 旧名。现在收到非会员上限（≤2K），不再收到 1K。
 * 保留是为了已经编进私有 overlay 的调用点还能编译。
 */
export function clampGptBasicRequest<T extends GptTierInput>(model: string, request: T): T {
  return clampGptNonMemberRequest(model, request)
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
 * 智能体、阶段授权、批次和模板这些入口会先收到非会员上限，再按收后的请求计价。
 * 报价和预扣必须用这一份，不能再写死倍率 1：2K 中画质已经是 2。
 */
export function gptCeilingRateMultiplier(model: string, request: GptTierInput): number {
  return gptImageRateMultiplier(model, clampGptNonMemberRequest(model, request))
}
