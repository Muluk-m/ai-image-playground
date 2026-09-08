import { zipSync } from 'fflate'
import { downloadBlob } from '../../../../lib/downloadImages'
import { sanitizePathSegment } from '../../../../lib/imageExport'
import { ensureImageCached } from '../../../../store'
import type { StoryboardRecord, StoryboardShotRecord } from '../types'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function storyboardMarkdown(record: StoryboardRecord): string {
  const lines = [`# ${record.title}`, '', record.summary, '']
  for (const shot of record.shots) {
    lines.push(
      `## 镜 ${shot.no} · ${shot.title}`,
      '',
      `- 画面：${shot.description}`,
      `- 运镜：${shot.camera}`,
      `- 台词：${shot.line || '（无）'}`,
      `- 时长：${shot.seconds} 秒`,
      `- 图片提示词：${shot.imagePrompt}`,
      `- 视频提示词：${shot.videoPrompt}`,
      '',
    )
  }
  return lines.join('\n')
}

/** 导出的是脚本，不是本地任务状态：任务 id 换个设备就没有意义。 */
export function storyboardExportJson(record: StoryboardRecord): string {
  const shots = record.shots.map(
    ({ imageTaskId: _t, imageId: _i, videoTaskId: _v, ...shot }: StoryboardShotRecord) => shot,
  )
  return `${JSON.stringify({ ...record, shots }, null, 2)}\n`
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; extension: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/)
  if (!match) return null
  const [, mime, base64, payload] = match
  const text = base64 ? atob(payload ?? '') : decodeURIComponent(payload ?? '')
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
  return { bytes, extension: MIME_EXTENSIONS[mime ?? ''] ?? (mime ?? '').split('/')[1] ?? 'png' }
}

export function shotFileName(no: number, extension: string): string {
  return `镜${String(no).padStart(2, '0')}.${extension}`
}

export async function storyboardZipFiles(
  record: StoryboardRecord,
  loadImage: (id: string) => Promise<string | undefined> = ensureImageCached,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {
    'storyboard.md': new TextEncoder().encode(storyboardMarkdown(record)),
    'storyboard.json': new TextEncoder().encode(storyboardExportJson(record)),
  }
  for (const shot of record.shots) {
    if (!shot.imageId) continue
    const dataUrl = await loadImage(shot.imageId)
    const decoded = dataUrl ? decodeDataUrl(dataUrl) : null
    if (decoded) files[shotFileName(shot.no, decoded.extension)] = decoded.bytes
  }
  return files
}

export async function downloadStoryboardZip(
  record: StoryboardRecord,
  loadImage?: (id: string) => Promise<string | undefined>,
): Promise<void> {
  const files = await storyboardZipFiles(record, loadImage)
  const zipped = zipSync(files, { level: 0 })
  downloadBlob(
    new Blob([zipped as BlobPart], { type: 'application/zip' }),
    `${sanitizePathSegment(record.title)}-分镜.zip`,
  )
}
