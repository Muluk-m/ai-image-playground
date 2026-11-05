import { findCatalogModel } from '@image-playground/shared/model-catalog'
import type { AdapterCapabilities, ResolutionTier } from './types'

const RESOLUTION_TIERS: ReadonlySet<string> = new Set(['1K', '2K', '4K'])

export function isResolutionTier(value: string): value is ResolutionTier {
  return RESOLUTION_TIERS.has(value)
}

/**
 * 目录里的张数、比例、参考图是能力声明的底稿。
 * 路由差异（是否兑现 size、原生 n、防改写）由各适配器补上。
 */
export function catalogCapabilities(
  model: string,
  patch: Partial<AdapterCapabilities> &
    Pick<AdapterCapabilities, 'honorsSize' | 'promptGuard' | 'nativeCount'>,
): AdapterCapabilities {
  const image = findCatalogModel(model)?.image
  const tiers = (image?.tiers.map((tier) => tier.id).filter(isResolutionTier) ?? [
    '1K',
  ]) as ResolutionTier[]
  return {
    tiers: patch.tiers ?? tiers,
    memberTiers: patch.memberTiers ?? (tiers.includes('4K') ? ['4K'] : []),
    ratios: patch.ratios ?? (image ? [...image.ratios] : ['1:1']),
    maxCount: patch.maxCount ?? image?.count.max ?? 1,
    nativeCount: patch.nativeCount,
    maxReferences: patch.maxReferences ?? image?.references.max ?? 0,
    mask: patch.mask ?? image?.operations.includes('mask_edit') ?? false,
    formats: patch.formats ?? ['png', 'jpeg', 'webp'],
    background: patch.background ?? false,
    moderation: patch.moderation ?? false,
    honorsSize: patch.honorsSize,
    promptGuard: patch.promptGuard,
  }
}
