import { encodeCanvas } from './encode'
import type { Layout } from './layout'
import { createOutputCanvas } from './render'
import type { ToolOutput, ToolSource } from './tool'

/** 合成产物一律出 JPG 0.9：拼图、长图多是照片，PNG 会大好几倍。 */
const COMPOSE_TYPE = 'image/jpeg'
const COMPOSE_QUALITY = 0.9

export async function encodeComposed(canvas: HTMLCanvasElement): Promise<ToolOutput> {
  const encoded = await encodeCanvas(canvas, COMPOSE_TYPE, COMPOSE_QUALITY)
  return { ...encoded, width: canvas.width, height: canvas.height }
}

/** 把一张图居中铺满一个格子（多出的部分裁掉）。 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / bitmap.width, height / bitmap.height)
  const sw = width / scale
  const sh = height / scale
  ctx.drawImage(
    bitmap,
    (bitmap.width - sw) / 2,
    (bitmap.height - sh) / 2,
    sw,
    sh,
    x,
    y,
    width,
    height,
  )
}

export function drawLayout(
  sources: readonly ToolSource[],
  layout: Layout,
  background: string,
): HTMLCanvasElement {
  const { canvas, ctx } = createOutputCanvas(layout.width, layout.height, COMPOSE_TYPE)
  ctx.fillStyle = background
  ctx.fillRect(0, 0, layout.width, layout.height)
  for (const place of layout.placements)
    drawCover(ctx, sources[place.index].bitmap, place.x, place.y, place.width, place.height)
  return canvas
}
