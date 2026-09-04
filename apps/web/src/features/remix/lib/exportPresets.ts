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
