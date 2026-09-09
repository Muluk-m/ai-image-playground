import type { ProductBox } from '@image-playground/shared'
import { PRODUCT_ALPHA_THRESHOLD } from './assessMatte'
import type { ProductAlpha } from './types'

/**
 * Keep whole foreground components that touch the plan's box, not just the pixels inside it.
 * Eight-connected pixels preserve diagonal cords. Sub-threshold alpha remains available to
 * the existing in-box attachment recovery, but cannot bridge separate foreground objects.
 */
export function filterProductAlpha(matte: ProductAlpha, box: ProductBox | null): ProductAlpha {
  if (!box) return matte
  const { alpha, width, height } = matte
  const left = Math.max(0, Math.floor(box.x * width))
  const top = Math.max(0, Math.floor(box.y * height))
  const right = Math.min(width, Math.ceil((box.x + box.w) * width))
  const bottom = Math.min(height, Math.ceil((box.y + box.h) * height))
  const kept = new Uint8Array(alpha.length)
  const queue = new Uint32Array(alpha.length)
  let end = 0

  // All seeds belong to components that intersect the box. Flood outward without clipping.
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = y * width + x
      if (alpha[index] < PRODUCT_ALPHA_THRESHOLD) continue
      kept[index] = 1
      queue[end++] = index
    }
  }
  for (let cursor = 0; cursor < end; cursor++) {
    const index = queue[cursor]
    const x = index % width
    const y = (index - x) / width
    for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
        const next = ny * width + nx
        if (kept[next] || alpha[next] < PRODUCT_ALPHA_THRESHOLD) continue
        kept[next] = 1
        queue[end++] = next
      }
    }
  }

  let filtered: Uint8ClampedArray | undefined
  for (let index = 0; index < alpha.length; index++) {
    if (alpha[index] < PRODUCT_ALPHA_THRESHOLD || kept[index]) continue
    filtered ??= alpha.slice()
    filtered[index] = 0
  }
  return filtered ? { alpha: filtered, width, height } : matte
}
