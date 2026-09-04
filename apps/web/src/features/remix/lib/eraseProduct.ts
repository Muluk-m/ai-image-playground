import type { ProductBox } from '@image-playground/shared'
import { loadImage } from '../../../lib/canvasImage'

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** 框边留一点余量，视觉模型给的框常压着产品轮廓。按图片边长取，横竖各算各的。 */
export const PRODUCT_ERASE_PADDING = 0.02

const NEUTRAL_GRAY = '#8a8a8a'

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value))
}

export function productBoxToPixelRect(
  box: ProductBox,
  size: { width: number; height: number },
  padding = 0,
): PixelRect | null {
  const padX = padding * size.width
  const padY = padding * size.height
  const left = Math.round(clamp(box.x * size.width - padX, size.width))
  const top = Math.round(clamp(box.y * size.height - padY, size.height))
  const right = Math.round(clamp((box.x + box.w) * size.width + padX, size.width))
  const bottom = Math.round(clamp((box.y + box.h) * size.height + padY, size.height))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 竞品图里留着产品时模型会照它画，所以提交前把那块填成中性灰。 */
export async function eraseProductArea(dataUrl: string, box: ProductBox): Promise<string> {
  const image = await loadImage(dataUrl)
  const size = { width: image.naturalWidth, height: image.naturalHeight }
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  ctx.drawImage(image, 0, 0)
  const rect = productBoxToPixelRect(box, size, PRODUCT_ERASE_PADDING)
  if (rect) {
    ctx.fillStyle = NEUTRAL_GRAY
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  }
  return canvas.toDataURL('image/png')
}
