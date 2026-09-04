import type { ShotType } from '@image-playground/shared'
import { SHOT_TYPE_LABELS } from '../types'

export interface Size {
  width: number
  height: number
}

/** 裁切偏移，-1 贴一边、0 居中、1 贴另一边。 */
export interface CropOffset {
  x: number
  y: number
}

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

export const CENTER_OFFSET: CropOffset = { x: 0, y: 0 }

function clampOffset(value: number): number {
  return Math.min(1, Math.max(-1, value))
}

/** 先裁到目标比例再缩放：edits 端点不遵守 size，回来的尺寸在几档之间浮动。 */
export function computeCenterCrop(
  source: Size,
  target: Size,
  offset: CropOffset = CENTER_OFFSET,
): CropRect {
  const targetRatio = target.width / target.height
  const wider = source.width / source.height > targetRatio
  // 先把尺寸取整再算偏移，否则两头各自四舍五入会让裁切框越过原图右下边。
  const sw = Math.round(wider ? source.height * targetRatio : source.width)
  const sh = Math.round(wider ? source.height : source.width / targetRatio)
  return {
    sx: Math.round(((source.width - sw) / 2) * (1 + clampOffset(offset.x))),
    sy: Math.round(((source.height - sh) / 2) * (1 + clampOffset(offset.y))),
    sw,
    sh,
  }
}

export const EXPORT_FITS = ['crop', 'letterbox'] as const
export type ExportFit = (typeof EXPORT_FITS)[number]

export interface FitRect {
  dx: number
  dy: number
  dw: number
  dh: number
}

/** 卖点图的文字贴着画面边缘，中心裁切会切掉，所以它默认补边而不是裁切。 */
export function defaultExportFit(shotType: ShotType): ExportFit {
  return shotType === 'selling-point' ? 'letterbox' : 'crop'
}

/** 整幅缩进目标尺寸并居中，余下的两条边留白。 */
export function computeLetterbox(source: Size, target: Size): FitRect {
  const scale = Math.min(target.width / source.width, target.height / source.height)
  const dw = Math.round(source.width * scale)
  const dh = Math.round(source.height * scale)
  return {
    dx: Math.round((target.width - dw) / 2),
    dy: Math.round((target.height - dh) / 2),
    dw,
    dh,
  }
}

/** 留白的底色：原图四边一圈的平均色，边缘全透明时用白。 */
export function edgeAverageColor(pixels: Uint8ClampedArray, size: Size): string {
  let red = 0
  let green = 0
  let blue = 0
  let counted = 0
  const take = (x: number, y: number) => {
    const at = (y * size.width + x) * 4
    if ((pixels[at + 3] ?? 0) < 8) return
    red += pixels[at] ?? 0
    green += pixels[at + 1] ?? 0
    blue += pixels[at + 2] ?? 0
    counted += 1
  }
  for (let x = 0; x < size.width; x += 1) {
    take(x, 0)
    take(x, size.height - 1)
  }
  for (let y = 1; y < size.height - 1; y += 1) {
    take(0, y)
    take(size.width - 1, y)
  }
  if (counted === 0) return '#ffffff'
  const channel = (total: number) =>
    Math.round(total / counted)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

export function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  return cleaned || '未命名'
}

export function exportFileName(shotIndex: number, shotType: ShotType, imageIndex = 0): string {
  const order = String(shotIndex + 1).padStart(2, '0')
  const suffix = imageIndex > 0 ? `-${imageIndex + 1}` : ''
  return `${order}-${SHOT_TYPE_LABELS[shotType]}${suffix}.png`
}

export function exportEntryName(
  setName: string,
  shotIndex: number,
  shotType: ShotType,
  imageIndex = 0,
): string {
  return `${sanitizePathSegment(setName)}/${exportFileName(shotIndex, shotType, imageIndex)}`
}
