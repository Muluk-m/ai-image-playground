import { i18next } from '../../../i18n'
import { canvasToBlob, loadImage } from '../../../lib/canvasImage'
import { blobDataUrl } from '../../../lib/cloudMedia'
import type { EditRect, RectEditMode } from '../rectEditStore'
import type { ImageEl } from './canvasDoc'

/** 拖动时框的最小边长（元素局部显示单位），防止拖出零宽高的无效框。 */
export const MIN_RECT_SIDE = 24

export type RectHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/**
 * 把一次拖拽落到编辑框上，并按模式夹回合法范围：
 * 裁切只能往里收（框 ⊆ 原图），扩图只能往外推（框 ⊇ 原图）。
 * 夹取放在这里而不是放在手势里——手势只管报位移，合法性是这条规则说了算。
 */
export function applyHandleDrag(
  mode: RectEditMode,
  base: EditRect,
  handle: RectHandle,
  delta: { x: number; y: number },
  element: { width: number; height: number },
): EditRect {
  let left = base.x
  let top = base.y
  let right = base.x + base.w
  let bottom = base.y + base.h
  if (handle.includes('w')) left += delta.x
  if (handle.includes('e')) right += delta.x
  if (handle.includes('n')) top += delta.y
  if (handle.includes('s')) bottom += delta.y

  if (mode === 'crop') {
    left = Math.min(Math.max(0, left), element.width - MIN_RECT_SIDE)
    top = Math.min(Math.max(0, top), element.height - MIN_RECT_SIDE)
    right = Math.max(Math.min(element.width, right), left + MIN_RECT_SIDE)
    bottom = Math.max(Math.min(element.height, bottom), top + MIN_RECT_SIDE)
  } else {
    left = Math.min(0, left)
    top = Math.min(0, top)
    right = Math.max(element.width, right)
    bottom = Math.max(element.height, bottom)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 元素局部坐标 → 页面坐标。Konva 绕左上角旋转，与 `elementBounds` 同一约定。 */
export function localToPage(el: ImageEl, point: { x: number; y: number }) {
  const rad = (el.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: el.x + point.x * cos - point.y * sin,
    y: el.y + point.x * sin + point.y * cos,
  }
}

/** 页面坐标的位移 → 元素局部坐标的位移（只转不平移）。 */
export function pageDeltaToLocal(el: ImageEl, delta: { x: number; y: number }) {
  const rad = (el.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: delta.x * cos + delta.y * sin, y: -delta.x * sin + delta.y * cos }
}

/** 编辑框对应的位图像素尺寸（显示单位按原图的像素密度折算）。 */
export function rectPixelSize(
  rect: EditRect,
  element: { width: number; height: number },
  natural: { width: number; height: number },
): { width: number; height: number; scaleX: number; scaleY: number } {
  const scaleX = natural.width / element.width
  const scaleY = natural.height / element.height
  return {
    width: Math.max(1, Math.round(rect.w * scaleX)),
    height: Math.max(1, Math.round(rect.h * scaleY)),
    scaleX,
    scaleY,
  }
}

function context(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(i18next.t('canvas.unsupported', { ns: 'lib' }))
  return ctx
}

/** 按编辑框裁出新位图。框始终在原图内（`applyHandleDrag` 保证），所以不用补边。 */
export async function cropBitmap(
  source: string,
  rect: EditRect,
  element: { width: number; height: number },
  natural: { width: number; height: number },
): Promise<string> {
  const image = await loadImage(source)
  const size = rectPixelSize(rect, element, natural)
  const ctx = context(size.width, size.height)
  ctx.drawImage(
    image,
    rect.x * size.scaleX,
    rect.y * size.scaleY,
    size.width,
    size.height,
    0,
    0,
    size.width,
    size.height,
  )
  return await blobDataUrl(await canvasToBlob(ctx.canvas, 'image/png'))
}

/**
 * 扩图的两张输入：放大后的画布（原图贴在框里的原位，四周补白）与配套遮罩
 * （原图那块不透明 = 保留，新增的边透明 = 交给模型画）。
 *
 * 补白用白色而不是透明：`/v1/images/edits` 的主图带 alpha 时部分网关会把它当成
 * 「这里也要改」，与遮罩打架；真正表达「改哪里」的只有遮罩那一张。
 */
export async function buildOutpaintInputs(
  source: string,
  rect: EditRect,
  element: { width: number; height: number },
  natural: { width: number; height: number },
): Promise<{ source: string; mask: string; width: number; height: number }> {
  const image = await loadImage(source)
  const size = rectPixelSize(rect, element, natural)
  const offsetX = Math.round(-rect.x * size.scaleX)
  const offsetY = Math.round(-rect.y * size.scaleY)

  const padded = context(size.width, size.height)
  padded.fillStyle = '#fff'
  padded.fillRect(0, 0, size.width, size.height)
  padded.drawImage(image, offsetX, offsetY, natural.width, natural.height)

  const mask = context(size.width, size.height)
  mask.clearRect(0, 0, size.width, size.height)
  mask.fillStyle = '#fff'
  mask.fillRect(offsetX, offsetY, natural.width, natural.height)

  return {
    source: await blobDataUrl(await canvasToBlob(padded.canvas, 'image/png')),
    mask: await blobDataUrl(await canvasToBlob(mask.canvas, 'image/png')),
    width: size.width,
    height: size.height,
  }
}
