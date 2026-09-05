import type { ShotType } from '@image-playground/shared'
import { type ExportFit, sanitizePathSegment } from '../../../lib/imageExport'
import { SHOT_TYPE_LABELS } from '../types'

/** 卖点图的文字贴着画面边缘，中心裁切会切掉，所以它默认补边而不是裁切。 */
export function defaultExportFit(shotType: ShotType): ExportFit {
  return shotType === 'selling-point' ? 'letterbox' : 'crop'
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
