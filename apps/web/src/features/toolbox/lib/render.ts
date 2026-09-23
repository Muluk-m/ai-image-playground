import { CanvasLimitError, currentCanvasLimits, exceedsCanvasLimits } from './canvasLimits'

export interface OutputCanvas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * 建一张输出画布。越界要在建之前判：`canvas.width = 20000` 不抛错，画出来的是一张空白图。
 * JPEG 没有 alpha，先铺白——不铺的话透明区会被编码器当成黑块。
 */
export function createOutputCanvas(width: number, height: number, type: string): OutputCanvas {
  if (exceedsCanvasLimits(width, height, currentCanvasLimits()))
    throw new CanvasLimitError(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  return { canvas, ctx }
}
