import type { ExportPreset, ShotType } from '@image-playground/shared'
import { zipSync } from 'fflate'
import { downloadBlob, imageDataUrl } from '../../../lib/downloadImages'
import {
  CENTER_OFFSET,
  type CropOffset,
  computeCenterCrop,
  exportEntryName,
  exportFileName,
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

async function exportedImage(
  imageId: string,
  preset: ExportPreset,
  offset: CropOffset,
): Promise<Blob> {
  const dataUrl = await imageDataUrl(imageId)
  if (!dataUrl) throw new Error('找不到这张图')
  return renderToPreset(dataUrl, preset, offset)
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
  downloadBlob(
    await exportedImage(imageId, preset, offset),
    exportFileName(shot.shotIndex, shot.shotType, imageIndex),
  )
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
        const rendered = await exportedImage(imageId, preset, offset)
        entries[exportEntryName(setName, shot.shotIndex, shot.shotType, imageIndex)] =
          new Uint8Array(await rendered.arrayBuffer())
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
