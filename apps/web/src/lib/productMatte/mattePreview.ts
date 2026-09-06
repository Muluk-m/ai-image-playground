import { encodeRgbaPngDataUrl } from './pngEncode'
import type { MaskPixels, ProductAlpha } from './types'

/** 盖在原图上的色块，用户要一眼看出抠到的是不是产品，所以要能透出下面的原图。 */
const PREVIEW_RGB = [37, 99, 235] as const
const PREVIEW_OPACITY = 0.55

export function alphaToPreviewPixels(matte: ProductAlpha): MaskPixels {
  const { width, height } = matte
  const total = width * height
  const data = new Uint8ClampedArray(total * 4)

  for (let i = 0; i < total; i++) {
    data[i * 4] = PREVIEW_RGB[0]
    data[i * 4 + 1] = PREVIEW_RGB[1]
    data[i * 4 + 2] = PREVIEW_RGB[2]
    data[i * 4 + 3] = Math.round(matte.alpha[i] * PREVIEW_OPACITY)
  }
  return { data, width, height }
}

export function alphaToMattePreview(matte: ProductAlpha): string {
  return encodeRgbaPngDataUrl(alphaToPreviewPixels(matte))
}
