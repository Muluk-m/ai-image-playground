import { authenticatedBffFetch } from '../../lib/authClient'
import { fetchImageDataUrl, queueOutputUrl } from '../../lib/channels/queueClient'
import { resolveMediaSource } from '../../lib/cloudMedia'
import { loadImageOriginal } from '../../lib/imageSource'
import { bffBaseUrl } from '../../lib/runtimeConfig'
import type { TaskRecord } from '../../types'
import type { AssetItem, StoredReferenceLoader } from '../agent/lib/assetItems'
import type { CanvasDoc } from '../canvas/lib/canvasDoc'
import { exportableElements, safeFileName } from '../canvas/lib/exportImages'
import { canvasImageName } from '../canvas/lib/imageInfo'
import type { ExportSource } from './export'

export async function originalBlob(source: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const resolved = await resolveMediaSource(source, 'original', true)
  const response = await fetch(resolved, { signal })
  if (!response.ok) throw new Error('Original image unavailable')
  return response.blob()
}
export function taskExportSources(tasks: readonly TaskRecord[]): ExportSource[] {
  return tasks.flatMap((task) =>
    (task.outputImages ?? []).map((ref, index) => ({
      id: `${task.id}:${ref}`,
      name: `image-${stamp(task.createdAt)}${task.outputImages.length > 1 ? `-${index + 1}` : ''}`,
      media: 'image' as const,
      load: async (signal?: AbortSignal) => {
        const source = await loadImageOriginal(ref)
        if (!source) throw new Error('Original image unavailable')
        return originalBlob(source, signal)
      },
    })),
  )
}
function stamp(time: number) {
  const date = new Date(time)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}
export function canvasExportSources(doc: CanvasDoc, ids?: Iterable<string>): ExportSource[] {
  return exportableElements(doc, ids).map((element) => ({
    id: element.id,
    name: safeFileName(canvasImageName(element)),
    media: element.video ? 'video' : 'image',
    load: async (signal) => {
      if (element.video) {
        const response = await authenticatedBffFetch(
          queueOutputUrl(element.video.taskId, element.video.outputIndex),
          { signal },
        )
        if (!response.ok) throw new Error('Video unavailable')
        return response.blob()
      }
      const source = doc.files[element.fileId]
      if (!source) throw new Error('Original image unavailable')
      return originalBlob(source, signal)
    },
  }))
}
export function assetExportSource(
  item: AssetItem,
  loadReference: StoredReferenceLoader,
): ExportSource {
  return {
    id: item.id,
    name: safeFileName(item.title),
    media: item.media,
    load: async (signal) => {
      if (item.open.kind === 'source') {
        if (item.open.mediaId) return originalBlob(`aip-media:${item.open.mediaId}`, signal)
        const ref = item.open.reference
        const source = ref
          ? await loadReference(ref.conversationId, ref.messageId, ref.index, 'original')
          : await item.load()
        if (!source) throw new Error('Original image unavailable')
        return originalBlob(source, signal)
      }
      const artifact = item.open.message.artifacts?.find((one) => one.artifactId === item.id)
      if (artifact) {
        if (artifact.media === 'video') {
          const response = await authenticatedBffFetch(
            queueOutputUrl(artifact.taskId, artifact.outputIndex),
            { signal },
          )
          if (!response.ok) throw new Error('Video unavailable')
          return response.blob()
        }
        return originalBlob(
          await fetchImageDataUrl(
            bffBaseUrl(),
            artifact.taskId,
            artifact.outputIndex,
            artifact.mime,
            signal,
          ),
          signal,
        )
      }
      const { fetchedCanvasId } = await import('../agent/lib/artifactDelivery')
      const image = item.open.message.fetchedImages?.find(
        (_, index) =>
          fetchedCanvasId(
            item.open.kind === 'result' ? item.open.message.toolCallId : '',
            index,
          ) === item.id,
      )
      if (!image) throw new Error('Original image unavailable')
      return originalBlob(`aip-media:${image.imageId}`, signal)
    },
  }
}
