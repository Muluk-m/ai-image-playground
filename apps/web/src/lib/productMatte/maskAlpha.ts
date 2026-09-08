import { loadImage } from '../canvasImage'
import { encodeRgbaPngDataUrl, packRgba, WHITE } from './pngEncode'
import type { ProductAlpha } from './types'

/** 遮罩 PNG 的 alpha 通道就是产品 alpha：不透明处保留，透明处重绘。 */
export async function maskDataUrlToAlpha(maskDataUrl: string): Promise<ProductAlpha> {
  const image = await loadImage(maskDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
  return { alpha, width: canvas.width, height: canvas.height }
}

/** `maskDataUrlToAlpha` 的逆。不阈值化：附件回捞靠的正是那些弱响应。 */
export function alphaToDataUrl(matte: ProductAlpha): string {
  return encodeRgbaPngDataUrl(packRgba(matte.alpha, matte.width, matte.height, WHITE))
}
