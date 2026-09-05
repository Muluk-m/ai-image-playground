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

export type MatteFailureReason = 'too-small' | 'too-large'

export interface MatteAssessment {
  ok: boolean
  coverage: number
  reason?: MatteFailureReason
}
