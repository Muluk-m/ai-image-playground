import { type BgSwapMode, DEFAULT_BG_SWAP_MODE } from '@image-playground/shared'
import type { LegacyProductSource, LegacyTarget } from '../types'

export const PRODUCT_SWAPPED_LABEL = '已换产品'

/** 出图按钮上的字，跟着右栏选的模式走。 */
export const ACTION_LABELS: Record<BgSwapMode, string> = {
  background: '换背景',
  'replace-product': '换产品',
  'replace-and-background': '换产品并换背景',
}

/** 遮罩重绘的是哪一侧；null = 这一模式整图重画，不带遮罩。 */
export type MaskSide = 'background' | 'product'

/** 右栏的两组分段合起来就是这一版要跑的模式；产品来源是原图时目标那一档不参与。 */
export function bgSwapMode(source: LegacyProductSource, target: LegacyTarget): BgSwapMode {
  if (source === 'original') return DEFAULT_BG_SWAP_MODE
  return target === 'product-only' ? 'replace-product' : 'replace-and-background'
}

export function swapsProduct(mode: BgSwapMode | undefined): boolean {
  return mode === 'replace-product' || mode === 'replace-and-background'
}

/** 背景没动的那一版不该挂背景方案句：那句描述的环境从来没被画出来。 */
export function changesBackground(mode: BgSwapMode | undefined): boolean {
  return mode !== 'replace-product'
}

export function maskSideFor(mode: BgSwapMode): MaskSide | null {
  if (mode === 'background') return 'background'
  return mode === 'replace-product' ? 'product' : null
}
