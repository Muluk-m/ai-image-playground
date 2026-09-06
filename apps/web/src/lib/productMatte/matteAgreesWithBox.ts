import type { ProductBox } from '@image-playground/shared'
import { PRODUCT_ALPHA_THRESHOLD } from './assessMatte'
import type { ProductAlpha } from './types'

export const MATTE_BOX_IOU_THRESHOLD = 0.5

/** 蒙版的外接框，归一化到 0-1；一个产品像素都没有时为 null。 */
export function matteBounds(matte: ProductAlpha): ProductBox | null {
  const { width, height } = matte
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (matte.alpha[y * width + x] < PRODUCT_ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return null
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
  }
}

function iou(a: ProductBox, b: ProductBox): number {
  const overlapW = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const overlapH = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const intersection = overlapW * overlapH
  const union = a.w * a.h + b.w * b.h - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * 蒙版抠中的是不是方案说的那个产品。占比正常也可能抠错对象——试点里显著性模型
 * 抠中了说明气泡而不是浴缸，拿它去重绘会把产品重画掉。
 */
export function matteAgreesWithBox(
  matte: ProductAlpha,
  productBox: ProductBox | null,
  threshold: number = MATTE_BOX_IOU_THRESHOLD,
): boolean {
  const bounds = matteBounds(matte)
  if (!bounds) return false
  if (!productBox) return true
  return iou(bounds, productBox) >= threshold
}
