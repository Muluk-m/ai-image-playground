/** 单通道产品 alpha：`alpha.length === width * height`，255 = 产品，0 = 背景。 */
export interface ProductAlpha {
  alpha: Uint8ClampedArray
  width: number
  height: number
}

export interface MaskPixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 抠出来了但占比不对：太小说明没抠到产品，太大说明把整张图当成了产品。 */
export type MatteCoverageReason = 'too-small' | 'too-large'

export type MatteAssessment =
  | { ok: true; coverage: number }
  | { ok: false; coverage: number; reason: MatteCoverageReason }
