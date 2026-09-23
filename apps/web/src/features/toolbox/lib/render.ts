import { CanvasLimitError, currentCanvasLimits, exceedsCanvasLimits } from './canvasLimits'
import { orientedSize, type Plan } from './geometry'

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

/** 按几何计划画一张：先在整幅上旋转 / 翻转，再从摆正的整幅里取裁剪区缩放到输出尺寸。 */
export function renderPlan(bitmap: ImageBitmap, plan: Plan, type: string): HTMLCanvasElement {
  const { rotate, flipH, flipV } = plan.orientation
  const oriented = orientedSize(bitmap.width, bitmap.height, rotate)
  let upright: CanvasImageSource = bitmap
  if (rotate !== 0 || flipH || flipV) {
    const turned = createOutputCanvas(oriented.width, oriented.height, 'image/png')
    turned.ctx.translate(oriented.width / 2, oriented.height / 2)
    turned.ctx.rotate((rotate * Math.PI) / 180)
    turned.ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
    turned.ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)
    upright = turned.canvas
  }
  const out = createOutputCanvas(plan.width, plan.height, type)
  const { x, y, width, height } = plan.crop
  out.ctx.drawImage(upright, x, y, width, height, 0, 0, plan.width, plan.height)
  return out.canvas
}
