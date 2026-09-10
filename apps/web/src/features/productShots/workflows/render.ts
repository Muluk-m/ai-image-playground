import { zipSync } from 'fflate'
import { downloadBlob, imageDataUrl } from '../../../lib/downloadImages'
import { sanitizePathSegment } from '../../../lib/imageExport'
import type { ProductShotVersion } from '../types'
import { KIT_FORMATS } from './plan'

export async function renderKitImage(imageId: string, version: ProductShotVersion): Promise<Blob> {
  const spec = version.workflow?.spec
  if (spec?.kind !== 'kit') throw new Error('这不是派生图片')
  const src = await imageDataUrl(imageId)
  if (!src) throw new Error('图片已丢失')
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
  const [width, height] = KIT_FORMATS[spec.format].size.split('x').map(Number)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法导出图片')
  ctx.fillStyle = '#f2eee6'
  ctx.fillRect(0, 0, width, height)
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight),
    w = image.naturalWidth * scale,
    h = image.naturalHeight * scale
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h)
  if (spec.title) {
    ctx.fillStyle = 'rgba(242,238,230,0.94)'
    ctx.fillRect(0, 0, width, height * 0.24)
    let font = Math.round(width * 0.048),
      lines: string[] = []
    do {
      ctx.font = `500 ${font}px sans-serif`
      lines = ['']
      for (const character of spec.title) {
        const last = lines.length - 1
        if (ctx.measureText(lines[last] + character).width > width * 0.86) lines.push(character)
        else lines[last] += character
      }
      if (lines.length * font * 1.4 <= height * 0.18) break
      font -= 2
    } while (font > 14)
    ctx.fillStyle = '#34312b'
    ctx.textBaseline = 'top'
    lines.forEach((line, index) =>
      ctx.fillText(line, width * 0.07, height * 0.04 + index * font * 1.4),
    )
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))), 'image/png'),
  )
}
export async function downloadKit(
  name: string,
  entries: { imageId: string; version: ProductShotVersion }[],
): Promise<void> {
  const files: Record<string, Uint8Array> = {}
  for (const [index, entry] of entries.entries()) {
    const spec = entry.version.workflow?.spec
    if (spec?.kind !== 'kit') continue
    const blob = await renderKitImage(entry.imageId, entry.version)
    files[`${index + 1}-${spec.format}-${spec.language}.png`] = new Uint8Array(
      await blob.arrayBuffer(),
    )
  }
  if (!Object.keys(files).length) throw new Error('没有已完成的派生图')
  downloadBlob(
    new Blob([new Uint8Array(zipSync(files)).buffer], { type: 'application/zip' }),
    `${sanitizePathSegment(name)}.zip`,
  )
}
