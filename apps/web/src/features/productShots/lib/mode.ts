import { type BgSwapMode, DEFAULT_BG_SWAP_MODE } from '@image-playground/shared'
import type { LegacyProductSource, LegacyTarget } from '../types'
import type { ProductShotAction } from './actions'

/** 遮罩重绘的是哪一侧；null = 这一动作整图重画，不带遮罩。 */
export type MaskSide = 'background' | 'product'

/** 旧记录存的是「产品来源 + 目标」两组分段，读成现在的一个动作。 */
export function legacyJobMode(
  source: LegacyProductSource | undefined,
  target: LegacyTarget | undefined,
): BgSwapMode {
  if (source !== 'asset') return DEFAULT_BG_SWAP_MODE
  return target === 'product-and-background' ? 'replace-and-background' : 'replace-product'
}

/** 背景没动的那一版不该挂背景方案句：那句描述的环境从来没被画出来。 */
export function changesBackground(mode: ProductShotAction | undefined): boolean {
  return mode !== 'replace-product'
}

export function maskSideFor(mode: ProductShotAction): MaskSide | null {
  if (mode === 'background') return 'background'
  return mode === 'replace-product' ? 'product' : null
}
