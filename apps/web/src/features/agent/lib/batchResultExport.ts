import type { AgentToolArtifact } from '@image-playground/shared'
import { zipSync } from 'fflate'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { fetchImageDataUrl, queueOutputUrl } from '../../../lib/channels/queueClient'
import { downloadBlob } from '../../../lib/downloadImages'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { safeFileName } from '../../canvas/lib/exportImages'
import { extensionFor, uniqueFileNames } from '../../toolbox/lib/naming'
import { batchItemStatus } from './batchStatusGroups'

/** 输入名里原有的媒体扩展名。落盘扩展名按真实字节另给，不去掉会变成 `图.png.png`。 */
const MEDIA_EXTENSION = /\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov)$/i

export interface BatchResultSource {
  readonly progress?: string
  readonly execution?: {
    readonly status: string
    readonly artifacts?: readonly AgentToolArtifact[]
  }
  /** 行上用户认得的名字，通常是第一张输入图的名字。 */
  readonly label: string
}

export interface BatchResultFile {
  readonly artifact: AgentToolArtifact
  readonly stem: string
}

export interface BatchExportResult {
  exported: number
  failed: number
}

/**
 * 当前已完成条目的产物，按计划里的顺序。
 * 还在排队、失败，以及同一次条目更早尝试留下的产物，都不是这次要拿走的结果。
 */
export function batchResultFiles(items: readonly BatchResultSource[]): BatchResultFile[] {
  const files: BatchResultFile[] = []
  items.forEach((item, index) => {
    if (batchItemStatus(item) !== 'completed') return
    const artifacts = item.execution?.artifacts ?? []
    if (artifacts.length === 0) return
    const position = String(index + 1).padStart(2, '0')
    const label = safeFileName(item.label).replace(MEDIA_EXTENSION, '').trim() || 'image'
    artifacts.forEach((artifact, artifactIndex) => {
      const stem =
        artifacts.length > 1 ? `${position}-${label}-${artifactIndex + 1}` : `${position}-${label}`
      files.push({ artifact, stem })
    })
  })
  return files
}

/**
 * 一件直接落盘，多件打成一个不压缩的 zip。
 * 多件不逐个点击下载：浏览器会把连续下载当成滥用，只留下最后一件。
 */
export async function exportBatchResults(
  files: readonly BatchResultFile[],
  options: {
    baseName: string
    onProgress?: (done: number, total: number) => void
    fetchArtifact?: (artifact: AgentToolArtifact) => Promise<Blob | null>
  },
): Promise<BatchExportResult> {
  const fetchArtifact = options.fetchArtifact ?? fetchBatchArtifact
  const ready: { name: string; blob: Blob }[] = []
  let failed = 0
  for (const [index, file] of files.entries()) {
    const blob = await fetchArtifact(file.artifact).catch(() => null)
    options.onProgress?.(index + 1, files.length)
    if (!blob) {
      failed += 1
      continue
    }
    const ext =
      file.artifact.media === 'video' ? 'mp4' : extensionFor(blob.type || file.artifact.mime)
    ready.push({ name: `${file.stem}.${ext}`, blob })
  }
  if (ready.length === 0) return { exported: 0, failed }
  const names = uniqueFileNames(ready.map((file) => file.name))
  if (ready.length === 1) {
    downloadBlob(ready[0]!.blob, names[0]!)
    return { exported: 1, failed }
  }
  const zipped: Record<string, Uint8Array> = {}
  for (const [index, file] of ready.entries()) {
    zipped[names[index]!] = new Uint8Array(await file.blob.arrayBuffer())
  }
  downloadBlob(
    new Blob([zipSync(zipped, { level: 0 }) as BlobPart], { type: 'application/zip' }),
    `${safeFileName(options.baseName)}.zip`,
  )
  return { exported: ready.length, failed }
}

async function fetchBatchArtifact(artifact: AgentToolArtifact): Promise<Blob | null> {
  try {
    if (artifact.media === 'video') {
      const response = await authenticatedBffFetch(
        queueOutputUrl(artifact.taskId, artifact.outputIndex),
      )
      if (!response.ok) return null
      return await response.blob()
    }
    const dataUrl = await fetchImageDataUrl(
      bffBaseUrl(),
      artifact.taskId,
      artifact.outputIndex,
      artifact.mime,
    )
    return await dataUrlToBlob(dataUrl, artifact.mime)
  } catch (error) {
    console.warn('[agent] batch result export failed', error)
    return null
  }
}
