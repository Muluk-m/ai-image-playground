import { imageSizeTier, parseImageSize } from './image'

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
