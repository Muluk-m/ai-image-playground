import type { ExportPreset } from '@image-playground/shared'
import { zipSync } from 'fflate'
import { downloadBlob, imageDataUrl } from './downloadImages'

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

export const EXPORT_FIT_LABELS: Record<ExportFit, string> = { crop: '裁切', letterbox: '留白' }

export interface FitRect {
  dx: number
  dy: number
  dw: number
  dh: number
}

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = src
  })
}

const PROBE_EDGE = 64

/** 底色只看边缘，先缩到 64px 再取：整幅 getImageData 每张要拷几十 MB 像素。 */
function paddingColor(image: HTMLImageElement, source: Size): string {
  const scale = Math.min(1, PROBE_EDGE / Math.max(source.width, source.height))
  const size = {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
  const probe = document.createElement('canvas')
  probe.width = size.width
  probe.height = size.height
  const ctx = probe.getContext('2d')
  if (!ctx) return '#ffffff'
  ctx.drawImage(image, 0, 0, size.width, size.height)
  return edgeAverageColor(ctx.getImageData(0, 0, size.width, size.height).data, size)
}

async function renderToPreset(
  dataUrl: string,
  preset: ExportPreset,
  offset: CropOffset,
  fit: ExportFit,
): Promise<Blob> {
  const image = await loadImage(dataUrl)
  const source = { width: image.naturalWidth, height: image.naturalHeight }
  const canvas = document.createElement('canvas')
  canvas.width = preset.width
  canvas.height = preset.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  if (fit === 'letterbox') {
    const box = computeLetterbox(source, preset)
    ctx.fillStyle = paddingColor(image, source)
    ctx.fillRect(0, 0, preset.width, preset.height)
    ctx.drawImage(image, box.dx, box.dy, box.dw, box.dh)
  } else {
    const crop = computeCenterCrop(source, preset, offset)
    ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, preset.width, preset.height)
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('导出失败')
  return blob
}

async function exportedImage(
  imageId: string,
  preset: ExportPreset,
  offset: CropOffset,
  fit: ExportFit,
): Promise<Blob> {
  const dataUrl = await imageDataUrl(imageId)
  if (!dataUrl) throw new Error('找不到这张图')
  return renderToPreset(dataUrl, preset, offset, fit)
}

/** 打包里的一条：`path` 是 zip 内的相对路径。 */
export interface ExportEntry {
  path: string
  imageId: string
  fit: ExportFit
}

export interface ExportResult {
  count: number
  failed: number
}

/** 单张下载也走预设，导出的尺寸与打包里的一致。 */
export async function downloadExportedImage(
  fileName: string,
  imageId: string,
  fit: ExportFit,
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<void> {
  downloadBlob(await exportedImage(imageId, preset, offset, fit), fileName)
}

export async function downloadExportZip(
  zipName: string,
  entries: readonly ExportEntry[],
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<ExportResult> {
  const packed: Record<string, Uint8Array> = {}
  let failed = 0

  for (const entry of entries) {
    try {
      const rendered = await exportedImage(entry.imageId, preset, offset, entry.fit)
      packed[entry.path] = new Uint8Array(await rendered.arrayBuffer())
    } catch {
      failed++
    }
  }

  const count = Object.keys(packed).length
  if (count === 0) return { count, failed }

  const zipped = zipSync(packed, { level: 0 })
  downloadBlob(
    new Blob([zipped as BlobPart], { type: 'application/zip' }),
    `${sanitizePathSegment(zipName)}.zip`,
  )
  return { count, failed }
}
