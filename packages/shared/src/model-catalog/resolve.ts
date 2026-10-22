import {
  CATALOG_RATIOS,
  type CatalogRatio,
  IMAGE_TIERS,
  type ImageCapabilities,
  type ImageTier,
} from './schema'

const TIER_RANK: Readonly<Record<ImageTier, number>> = { '512': 0, '1K': 1, '2K': 2, '4K': 3 }

export function isImageTier(value: unknown): value is ImageTier {
  return typeof value === 'string' && (IMAGE_TIERS as readonly string[]).includes(value)
}

export function isCatalogRatio(value: unknown): value is CatalogRatio {
  return typeof value === 'string' && (CATALOG_RATIOS as readonly string[]).includes(value)
}

const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/

/** `16:9` → 16/9；格式不对或有 0 时 null。 */
export function catalogRatioValue(ratio: string): number | null {
  const match = ratio.match(RATIO_PATTERN)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0) || !(height > 0)) return null
  return width / height
}

/** 对数距离最近的支持比例：3:1 与 1:3 离 1:1 一样远。输入认不出时 undefined。 */
export function nearestCatalogRatio(
  ratio: string,
  supported: readonly CatalogRatio[],
): CatalogRatio | undefined {
  const target = catalogRatioValue(ratio)
  if (target === null) return undefined
  let best: CatalogRatio | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of supported) {
    const value = catalogRatioValue(candidate)
    if (value === null) continue
    const delta = Math.abs(Math.log(target) - Math.log(value))
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best
}

/** 不支持的档位回落到不超过它的最高一档；都比它高时取最低一档。 */
export function nearestImageTier(tier: ImageTier, supported: readonly ImageTier[]): ImageTier {
  const sorted = [...supported].sort((a, b) => TIER_RANK[a] - TIER_RANK[b])
  const atOrBelow = sorted.filter((one) => TIER_RANK[one] <= TIER_RANK[tier])
  return atOrBelow.at(-1) ?? sorted[0] ?? tier
}

export interface ImageRequestInput {
  /** 认不出的档位按缺省处理。 */
  readonly tier?: string
  /** `auto` 或 `宽:高`。 */
  readonly ratio?: string
  readonly n?: number
  /** 参考图张数。 */
  readonly references?: number
}

export interface ImageRequestAdjustment {
  readonly field: 'tier' | 'ratio' | 'n'
  readonly from: string | number
  readonly to: string | number
}

export type ResolvedImageRequest =
  | {
      readonly ok: true
      readonly tier: ImageTier
      readonly ratio: CatalogRatio | 'auto'
      readonly n: number
      /** 这个档位和比例的已知输出像素；不知道时缺省。 */
      readonly pixels?: string
      /** 做过的回落，界面据此提示一次，BFF 据此回显到卡片。 */
      readonly adjustments: readonly ImageRequestAdjustment[]
    }
  | {
      readonly ok: false
      readonly field: 'references'
      readonly max: number
    }

/**
 * 按模型能力规整一次出图请求：不支持的档位、比例、张数一律回落到最近的可用值并记下调整，
 * 前端和 BFF 共用同一个函数，所以界面预览的结果就是后端实际发出的参数。
 *
 * 只有参考图超上限会拒绝：少带一张参考图会悄悄改变结果，不能替用户丢。
 */
export function resolveImageRequest(
  caps: ImageCapabilities,
  input: ImageRequestInput,
): ResolvedImageRequest {
  const references = input.references ?? 0
  // 不是非负整数的张数同样拒绝：调用方会按它算剩余可传张数，不能带着坏值往下走。
  if (!Number.isInteger(references) || references < 0 || references > caps.references.max) {
    return { ok: false, field: 'references', max: caps.references.max }
  }

  const adjustments: ImageRequestAdjustment[] = []
  const tiers = caps.tiers.map((one) => one.id)

  const requestedTier = isImageTier(input.tier) ? input.tier : caps.defaultTier
  let tier = requestedTier
  if (!tiers.includes(tier)) {
    tier = nearestImageTier(tier, tiers)
    adjustments.push({ field: 'tier', from: requestedTier, to: tier })
  }

  const fallbackRatio: CatalogRatio = caps.ratios.includes('1:1') ? '1:1' : caps.ratios[0]!
  // 运行时可能收到非字符串（旧客户端、手写请求），按缺省处理而不是抛错。
  const requestedRatio = typeof input.ratio === 'string' ? input.ratio.trim() : undefined
  let ratio: CatalogRatio | 'auto'
  if (!requestedRatio || requestedRatio === 'auto') {
    ratio = caps.autoRatio ? 'auto' : fallbackRatio
    if (requestedRatio === 'auto' && !caps.autoRatio) {
      adjustments.push({ field: 'ratio', from: 'auto', to: ratio })
    }
  } else if (isCatalogRatio(requestedRatio) && caps.ratios.includes(requestedRatio)) {
    ratio = requestedRatio
  } else {
    ratio = nearestCatalogRatio(requestedRatio, caps.ratios) ?? fallbackRatio
    adjustments.push({ field: 'ratio', from: requestedRatio, to: ratio })
  }

  const requestedN = input.n ?? 1
  let n = requestedN
  if (!Number.isFinite(requestedN)) {
    // NaN / Infinity 进 JSON 会变成 null，调整记录里写成字符串。
    n = 1
    adjustments.push({ field: 'n', from: String(requestedN), to: n })
  } else if (!Number.isInteger(requestedN) || requestedN < 1 || requestedN > caps.count.max) {
    n = Math.min(caps.count.max, Math.max(1, Math.floor(requestedN)))
    adjustments.push({ field: 'n', from: requestedN, to: n })
  }

  const pixels =
    ratio === 'auto' ? undefined : caps.tiers.find((one) => one.id === tier)?.pixels[ratio]
  return { ok: true, tier, ratio, n, ...(pixels ? { pixels } : {}), adjustments }
}
