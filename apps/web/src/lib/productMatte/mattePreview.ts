import { encodeRgbaPngDataUrl, packRgba } from './pngEncode'
import type { MaskPixels, ProductAlpha } from './types'

/** 盖在原图上的色块，用户要一眼看出抠到的是不是产品，所以要能透出下面的原图。 */
const PREVIEW_RGB = [37, 99, 235] as const
const PREVIEW_OPACITY = 0.55

export function alphaToPreviewPixels(matte: ProductAlpha): MaskPixels {
  return packRgba(matte.alpha, matte.width, matte.height, PREVIEW_RGB, (value) =>
    Math.round(value * PREVIEW_OPACITY),
  )
}

export function alphaToMattePreview(matte: ProductAlpha): string {
  return encodeRgbaPngDataUrl(alphaToPreviewPixels(matte))
}
