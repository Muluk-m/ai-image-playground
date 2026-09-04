import type { ExportPreset, ShotType } from '@image-playground/shared'
import { zipSync } from 'fflate'
import { ensureImageCached, getCachedImage } from '../../../store'
import {
  CENTER_OFFSET,
  type CropOffset,
  computeCenterCrop,
  exportEntryName,
  sanitizePathSegment,
} from './exportPresets'

export interface SetExportShot {
  shotIndex: number
  shotType: ShotType
  imageIds: readonly string[]
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = src
  })
}

async function renderToPreset(
  dataUrl: string,
  preset: ExportPreset,
  offset: CropOffset,
): Promise<Blob> {
  const image = await loadImage(dataUrl)
  const crop = computeCenterCrop(
    { width: image.naturalWidth, height: image.naturalHeight },
    preset,
    offset,
  )
  const canvas = document.createElement('canvas')
  canvas.width = preset.width
  canvas.height = preset.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, preset.width, preset.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('导出失败')
  return blob
}

async function exportedBytes(
  imageId: string,
  preset: ExportPreset,
  offset: CropOffset,
): Promise<Uint8Array> {
  const dataUrl = getCachedImage(imageId) ?? (await ensureImageCached(imageId))
  if (!dataUrl) throw new Error('找不到这张图')
  const blob = await renderToPreset(dataUrl, preset, offset)
  return new Uint8Array(await blob.arrayBuffer())
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 单张下载也走预设，导出的尺寸与打包里的一致。 */
export async function downloadShotImage(
  setName: string,
  shot: SetExportShot,
  imageId: string,
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<void> {
  const imageIndex = Math.max(0, shot.imageIds.indexOf(imageId))
  const dataUrl = getCachedImage(imageId) ?? (await ensureImageCached(imageId))
  if (!dataUrl) throw new Error('找不到这张图')
  const name = exportEntryName(setName, shot.shotIndex, shot.shotType, imageIndex)
  downloadBlob(await renderToPreset(dataUrl, preset, offset), name.split('/').slice(1).join('/'))
}

export interface SetExportResult {
  count: number
  failed: number
}

export async function downloadSetZip(
  setName: string,
  shots: readonly SetExportShot[],
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<SetExportResult> {
  const entries: Record<string, Uint8Array> = {}
  let failed = 0

  for (const shot of shots) {
    for (const [imageIndex, imageId] of shot.imageIds.entries()) {
      try {
        entries[exportEntryName(setName, shot.shotIndex, shot.shotType, imageIndex)] =
          await exportedBytes(imageId, preset, offset)
      } catch {
        failed++
      }
    }
  }

  const count = Object.keys(entries).length
  if (count === 0) return { count, failed }

  const zipped = zipSync(entries, { level: 0 })
  downloadBlob(
    new Blob([zipped as BlobPart], { type: 'application/zip' }),
    `${sanitizePathSegment(setName)}.zip`,
  )
  return { count, failed }
}
