import { zipSync } from 'fflate'
import { dataUrlToBlob } from '../../../../lib/canvasImage'
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

function shotFileName(no: number, mime: string): string {
  const extension = MIME_EXTENSIONS[mime] ?? mime.split('/')[1] ?? 'png'
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
  const shots = record.shots.filter((shot) => shot.imageId)
  const images = await Promise.all(shots.map((shot) => loadImage(shot.imageId!)))
  for (const [index, dataUrl] of images.entries()) {
    if (!dataUrl) continue
    const blob = await dataUrlToBlob(dataUrl)
    files[shotFileName(shots[index]!.no, blob.type)] = new Uint8Array(await blob.arrayBuffer())
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
