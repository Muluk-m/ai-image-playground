import type { ProductBox } from '@image-playground/shared'
import { PRODUCT_ALPHA_THRESHOLD } from './assessMatte'
import { dilateBinary } from './morphology'
import type { ProductAlpha } from './types'

/** 抠图边缘压着产品轮廓，扩一圈才不会把边缘与接地阴影留在重绘区。按图宽取。 */
export const DEFAULT_MATTE_GROW_RATIO = 0.015

/** 龙头、把手这类附件在显著性图上只剩弱响应，用产品阈值捞不回来。 */
export const ATTACHMENT_ALPHA_THRESHOLD = 40

/** 细长判据：外接框长边至少是短边的两倍，否则那是画面里的另一个东西。 */
export const ATTACHMENT_MIN_ELONGATION = 2

export interface ExpandProductAlphaOptions {
  /** 膨胀半径占图宽的比例。 */
  growRatio?: number
  /** 方案给的产品框；给了才捞附件，捞的范围也限制在框内。 */
  productBox?: ProductBox | null
  attachmentThreshold?: number
  minElongation?: number
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

interface PixelRect {
  left: number
  top: number
  right: number
  bottom: number
}

function boxToRect(box: ProductBox, width: number, height: number): PixelRect {
  return {
    left: Math.max(0, Math.floor(box.x * width)),
    top: Math.max(0, Math.floor(box.y * height)),
    right: Math.min(width - 1, Math.ceil((box.x + box.w) * width) - 1),
    bottom: Math.min(height - 1, Math.ceil((box.y + box.h) * height) - 1),
  }
}

/**
 * 产品框内、与蒙版相连的细长弱响应区域并回产品：客户源图里落地龙头就是这样被
 * 显著性模型丢进重绘区的。返回并入的像素下标。
 */
function attachmentPixels(
  matte: ProductAlpha,
  grown: Float32Array,
  rect: PixelRect,
  threshold: number,
  minElongation: number,
): number[] {
  const { width, alpha } = matte
  const visited = new Uint8Array(alpha.length)
  const merged: number[] = []

  for (let y = rect.top; y <= rect.bottom; y++) {
    for (let x = rect.left; x <= rect.right; x++) {
      const start = y * width + x
      if (visited[start] || grown[start] > 0 || alpha[start] < threshold) continue

      const region: number[] = []
      const stack = [start]
      visited[start] = 1
      let touchesProduct = false
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y

      while (stack.length > 0) {
        const index = stack.pop() as number
        const px = index % width
        const py = (index - px) / width
        region.push(index)
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py

        for (const [dx, dy] of NEIGHBOURS) {
          const nx = px + dx
          const ny = py + dy
          if (nx < rect.left || nx > rect.right || ny < rect.top || ny > rect.bottom) continue
          const next = ny * width + nx
          if (grown[next] > 0) {
            touchesProduct = true
            continue
          }
          if (visited[next] || alpha[next] < threshold) continue
          visited[next] = 1
          stack.push(next)
        }
      }

      const boxWidth = maxX - minX + 1
      const boxHeight = maxY - minY + 1
      const elongation = Math.max(boxWidth, boxHeight) / Math.min(boxWidth, boxHeight)
      // 区域可能有几万个像素，展开成实参会爆栈。
      if (touchesProduct && elongation >= minElongation) for (const i of region) merged.push(i)
    }
  }
  return merged
}

/**
 * 抠出来的产品向外扩一圈，并把产品框内与它相连的细长附件并进来。
 * 输出是二值 alpha：遮罩阈值与羽化在 `alphaToInpaintMask` 里做。
 */
export function expandProductAlpha(
  matte: ProductAlpha,
  options: ExpandProductAlphaOptions = {},
): ProductAlpha {
  const { width, height, alpha } = matte
  const total = width * height
  const radius = Math.round(width * (options.growRatio ?? DEFAULT_MATTE_GROW_RATIO))

  const strong = new Float32Array(total)
  for (let i = 0; i < total; i++) strong[i] = alpha[i] >= PRODUCT_ALPHA_THRESHOLD ? 255 : 0
  const grown = dilateBinary(strong, width, height, Math.max(0, radius))

  const out = new Uint8ClampedArray(total)
  for (let i = 0; i < total; i++) out[i] = grown[i] > 0 ? 255 : 0

  const box = options.productBox
  if (box) {
    const merged = attachmentPixels(
      matte,
      grown,
      boxToRect(box, width, height),
      options.attachmentThreshold ?? ATTACHMENT_ALPHA_THRESHOLD,
      options.minElongation ?? ATTACHMENT_MIN_ELONGATION,
    )
    for (const index of merged) out[index] = 255
  }

  return { alpha: out, width, height }
}
