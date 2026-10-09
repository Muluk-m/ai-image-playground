import { encodeCanvas, type OutputFormat } from '../toolbox/lib/encode'
import { extensionFor, outputFileName } from '../toolbox/lib/naming'
import { createOutputCanvas } from '../toolbox/lib/render'

export interface ExportSource {
  id: string
  name: string
  media: 'image' | 'video'
  preview?: string
  width?: number
  height?: number
  load: (signal?: AbortSignal) => Promise<Blob>
}
export type SizeMode = 'original' | 'width' | 'height' | 'percent'
export interface ExportSettings {
  mode: SizeMode
  value: number
  quality: number
  rows: { id: string; scale: number; format: Exclude<OutputFormat, 'keep'> }[]
}
export function exportSize(
  width: number,
  height: number,
  mode: SizeMode,
  value: number,
  scale: number,
) {
  if (![width, height, value, scale].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('Invalid output size')
  const ratio =
    mode === 'width'
      ? value / width
      : mode === 'height'
        ? value / height
        : mode === 'percent'
          ? value / 100
          : 1
  return {
    width: Math.max(1, Math.round(width * ratio * scale)),
    height: Math.max(1, Math.round(height * ratio * scale)),
  }
}

/** Decode one original at a time; every density is rendered directly from it. */
export async function prepareExports(
  sources: readonly ExportSource[],
  settings: ExportSettings,
  signal: AbortSignal,
  onProgress: (done: number) => void,
) {
  const files: { name: string; blob: Blob }[] = []
  for (const [index, source] of sources.entries()) {
    signal.throwIfAborted()
    const blob = await source.load(signal)
    signal.throwIfAborted()
    if (source.media === 'video') {
      files.push({ name: outputFileName(source.name, blob.type || 'video/mp4'), blob })
    } else {
      const bitmap = await createImageBitmap(blob)
      try {
        for (const row of settings.rows) {
          signal.throwIfAborted()
          const size = exportSize(
            bitmap.width,
            bitmap.height,
            settings.mode,
            settings.value,
            row.scale,
          )
          const { canvas, ctx } = createOutputCanvas(size.width, size.height, row.format)
          try {
            ctx.drawImage(bitmap, 0, 0, size.width, size.height)
            const encoded = await encodeCanvas(canvas, row.format, settings.quality / 100)
            files.push({
              name: `${source.name.replace(/\.[^./\\]+$/, '') || 'image'}${row.scale === 1 ? '' : `@${row.scale}x`}.${extensionFor(encoded.type)}`,
              blob: encoded.blob,
            })
          } finally {
            canvas.width = canvas.height = 0
          }
        }
      } finally {
        bitmap.close()
      }
    }
    onProgress(index + 1)
  }
  signal.throwIfAborted()
  return files
}
