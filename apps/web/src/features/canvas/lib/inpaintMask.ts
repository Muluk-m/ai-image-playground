import { i18next } from '../../../i18n'
import { canvasToBlob } from '../../../lib/canvasImage'
import { blobDataUrl } from '../../../lib/cloudMedia'
import {
  assertUsableMaskCoverage,
  classifyMaskAlpha,
  isUsableMaskLasso,
  maskPaintOperation,
} from '../../../lib/mask'
import type { ImageEl } from './canvasDoc'

export interface Point {
  readonly x: number
  readonly y: number
}

/** 遮罩位图尺寸。原生 mask 要求它与送上游那张主图逐像素同尺寸，别在别处再缩放。 */
export interface MaskSize {
  readonly width: number
  readonly height: number
}

/**
 * 一笔涂抹：**页面坐标**点列 + 页面坐标单位的笔宽。
 * 存页面坐标而不是遮罩像素坐标，是因为涂抹期间用户可以随意缩放平移画布，
 * 而笔画属于那张图，不属于当时那个相机。
 */
export interface MaskStroke {
  readonly tool: 'brush' | 'eraser'
  readonly points: readonly Point[]
  readonly width: number
}

/**
 * 渲染语义。`inverted: false` 是**遮罩**（`lib/mask.ts` 的约定）：不透明 = 保留、透明 = 可重绘。
 * `inverted: true` 是**界面预览**：画出来的就是可重绘区。两者共用同一份笔画数据与同一段
 * 光栅化代码，所以用户看见的紫色块与送上游的遮罩形状永远一致。
 */
export interface MaskRenderMode {
  readonly inverted: boolean
  readonly color: string
}

/**
 * 页面坐标 → 遮罩像素坐标。Konva 的 rotation 绕元素左上角（与 `elementBounds` 同一约定），
 * 所以这里是「平移到左上角 → 反向旋转 → 按展示尺寸与位图尺寸的比例缩放」。
 */
export function pageToMaskPixel(el: ImageEl, size: MaskSize, point: Point): Point {
  const rad = (el.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = point.x - el.x
  const dy = point.y - el.y
  return {
    x: ((dx * cos + dy * sin) / el.width) * size.width,
    y: ((-dx * sin + dy * cos) / el.height) * size.height,
  }
}

/**
 * 把一笔烧进画布：先描线，再把闭合轮廓填满。
 * 填充那一步是产品意图——用户画一条线圈住一块，松手整块都算选中，
 * 而不是只有笔尖实际划过的那几个像素。
 */
export function paintMaskStroke(
  ctx: CanvasRenderingContext2D,
  el: ImageEl,
  size: MaskSize,
  stroke: MaskStroke,
  mode: MaskRenderMode,
): void {
  const points = stroke.points.map((point) => pageToMaskPixel(el, size, point))
  const first = points[0]
  if (!first) return
  // 画布上的图锁比例（Transformer 对 image 开 keepRatio），两轴倍率本该相等；
  // 取均值只是为了图被外部数据改成非等比时笔宽仍然可用，而不是崩成 0。
  const scale = (size.width / el.width + size.height / el.height) / 2
  ctx.save()
  ctx.globalCompositeOperation = maskPaintOperation(stroke.tool, mode.inverted)
  ctx.fillStyle = mode.color
  ctx.strokeStyle = mode.color
  ctx.lineWidth = Math.max(1, stroke.width * scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
  // 单点轻触也要留下一个圆点：零长度路径 stroke 不出任何像素。
  if (points.length === 1) ctx.lineTo(first.x + 0.01, first.y)
  ctx.stroke()
  if (isUsableMaskLasso(points)) {
    ctx.closePath()
    ctx.fill('evenodd')
  }
  ctx.restore()
}

/**
 * 整张重放到 `canvas`（尺寸由调用方定好）。撤销就是丢掉最后一笔再调一次它：
 * 不维护增量位图，就不会有增量位图与笔画列表对不上的那一类 bug。
 */
export function renderMask(
  canvas: HTMLCanvasElement,
  el: ImageEl,
  strokes: readonly MaskStroke[],
  mode: MaskRenderMode,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(i18next.t('canvas.unsupported', { ns: 'lib' }))
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!mode.inverted) {
    // 遮罩底色是「全保留」：没涂过的地方必须完全不透明，否则整张图都成了可重绘区。
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
  }
  const size = { width: canvas.width, height: canvas.height }
  for (const stroke of strokes) paintMaskStroke(ctx, el, size, stroke, mode)
  return ctx
}

/**
 * 导出送上游的遮罩 PNG。空选区在这里就被 `assertUsableMaskCoverage` 拦下——
 * 让它走到上游只会换回一张整图重绘，用户还以为自己圈过了。
 */
export async function exportMaskDataUrl(
  el: ImageEl,
  size: MaskSize,
  strokes: readonly MaskStroke[],
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = renderMask(canvas, el, strokes, { inverted: false, color: '#fff' })
  assertUsableMaskCoverage(classifyMaskAlpha(ctx.getImageData(0, 0, size.width, size.height)))
  const blob = await canvasToBlob(canvas, 'image/png')
  return await blobDataUrl(blob)
}
