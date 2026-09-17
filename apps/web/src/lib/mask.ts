import { i18next } from '../i18n'
import type { InputImage } from '../types'
import type { Point } from './viewportTransform'

export type MaskCoverage = 'empty' | 'partial' | 'full'

export function validateMaskTarget(inputImages: InputImage[], targetImageId: string): InputImage {
  const target = inputImages.find((img) => img.id === targetImageId)
  if (!target) throw new Error(i18next.t('mask.baseImageMissing', { ns: 'lib' }))
  return target
}

export function orderInputImagesForMask(
  inputImages: InputImage[],
  targetImageId: string,
): InputImage[] {
  const target = validateMaskTarget(inputImages, targetImageId)
  return [target, ...inputImages.filter((img) => img.id !== targetImageId)]
}

/**
 * 遮罩画布上不透明 = 保留、透明 = 重绘。保留区语义（商品图改蒙版）下画笔与橡皮对调：
 * 涂 = 加入保留区，擦 = 移出保留区。
 */
export function maskPaintOperation(
  tool: 'brush' | 'eraser',
  keepSemantics: boolean,
): GlobalCompositeOperation {
  return (tool === 'brush') === keepSemantics ? 'source-over' : 'destination-out'
}

/** 圈选在抬笔时闭合并填充；笔刷仍只改变实际经过的像素。 */
export function isUsableMaskLasso(points: readonly Point[]): boolean {
  if (points.length < 3) return false
  const bounds = points.reduce(
    (box, point) => ({
      left: Math.min(box.left, point.x),
      right: Math.max(box.right, point.x),
      top: Math.min(box.top, point.y),
      bottom: Math.max(box.bottom, point.y),
    }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  )
  return bounds.right - bounds.left >= 1 && bounds.bottom - bounds.top >= 1
}

export function fillMaskLasso(
  ctx: CanvasRenderingContext2D,
  points: readonly Point[],
  keepSemantics: boolean,
): boolean {
  if (!isUsableMaskLasso(points)) return false
  ctx.save()
  ctx.globalCompositeOperation = maskPaintOperation('brush', keepSemantics)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.moveTo(points[0]!.x, points[0]!.y)
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.closePath()
  ctx.fill('evenodd')
  ctx.restore()
  return true
}

export function classifyMaskAlpha(imageData: Pick<ImageData, 'data'>): MaskCoverage {
  let edited = 0
  let fullyTransparent = 0
  const total = imageData.data.length / 4

  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] < 255) edited++
    if (imageData.data[i] === 0) fullyTransparent++
  }

  if (edited === 0) return 'empty'
  if (fullyTransparent === total) return 'full'
  return 'partial'
}

export function assertUsableMaskCoverage(coverage: MaskCoverage): void {
  if (coverage === 'empty') {
    throw new Error(i18next.t('mask.emptySelection', { ns: 'lib' }))
  }
}
