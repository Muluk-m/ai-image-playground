import {
  isProjectDocument,
  PROJECT_META_VALUE_MAX_CHARS,
  type ProjectDocument,
} from '@image-playground/shared'
import { scopedStorageName } from '../../../lib/authScope'
import { MediaRequestError, mediaIdentity, mediaJson } from '../../../lib/cloudMedia'
import type { CanvasDoc, CanvasEl } from './canvasDoc'

export interface MediaBinding {
  id: string
  sha256: string
}
export type MediaBindings = Record<string, MediaBinding>
export type LoadedBindings = Map<string, MediaBinding & { source: string }>

/**
 * 云端 meta 值有长度上限；超长的一条（例如很长的提示词）会让整份文档校验失败、项目整个停止
 * 同步。本机画布保留原文，上云时截到上限。
 */
function boundedMeta(meta: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [
      key,
      value.length > PROJECT_META_VALUE_MAX_CHARS
        ? value.slice(0, PROJECT_META_VALUE_MAX_CHARS)
        : value,
    ]),
  )
}

export function projectDocument(
  doc: CanvasDoc,
  bindings: LoadedBindings = new Map(),
): ProjectDocument | null {
  const elements = doc.elements.map((element) => {
    if (element.type === 'placeholder' && element.meta.cloudGeneration) {
      return {
        id: element.id,
        type: 'generation',
        generationId: element.meta.cloudGeneration.id,
        position: element.meta.cloudGeneration.position,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      }
    }
    if (element.type !== 'image') return element
    const source = doc.files[element.fileId]
    const bound = bindings.get(element.fileId)
    const mediaId = mediaIdentity(source) ?? (bound?.source === source ? bound?.id : undefined)
    // 视频也走这条：上传的是封面，片子本身留在队列，按 `video` 现拼播放地址。
    if (!mediaId) return null
    const { fileId: _fileId, ...image } = element
    return { ...image, mediaId, ...(image.meta ? { meta: boundedMeta(image.meta) } : {}) }
  })
  const document = { version: 1, elements }
  return isProjectDocument(document) ? document : null
}

interface Upload {
  id: string
  status: 'ready' | 'pending'
  uploadUrl?: string
}

export async function prepareProjectMedia(
  doc: CanvasDoc,
  persisted: MediaBindings,
  loaded: LoadedBindings,
  signal: AbortSignal,
  uploadMissing = true,
): Promise<void> {
  const scope = scopedStorageName('media')
  const current = () => {
    signal.throwIfAborted()
    if (scope !== scopedStorageName('media')) throw new Error('media_scope_changed')
  }
  const files = doc.files
  for (const element of doc.elements) {
    if (element.type !== 'image') continue
    if (!uploadMissing && !persisted[element.fileId]) continue
    const source = files[element.fileId]
    if (!source || mediaIdentity(source) || loaded.get(element.fileId)?.source === source) continue
    if (!source.startsWith('data:image/')) throw new Error('unsupported_local_media')
    current()
    const response = await fetch(source, { signal })
    const bytes = await response.arrayBuffer()
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    current()
    const previous = persisted[element.fileId]
    if (previous?.sha256 === sha256) {
      loaded.set(element.fileId, { ...previous, source })
      continue
    }
    if (!uploadMissing) continue
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    const upload = await mediaJson<Upload>('/uploads', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bytes: bytes.byteLength, contentType, sha256 }),
    })
    current()
    if (upload.status !== 'ready') {
      if (!upload.uploadUrl) throw new Error('invalid_media_upload')
      const sent = await fetch(upload.uploadUrl, {
        method: 'PUT',
        credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        headers: { 'content-type': contentType },
        body: bytes,
      })
      if (!sent.ok) throw new MediaRequestError(sent.status, 'media_upload_failed')
      current()
      const complete = await mediaJson<Upload>(`/${upload.id}/complete`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (complete.status !== 'ready' || complete.id !== upload.id)
        throw new Error('invalid_media_confirmation')
    }
    current()
    persisted[element.fileId] = { id: upload.id, sha256 }
    loaded.set(element.fileId, { id: upload.id, sha256, source })
  }
}

export function projectScene(document: ProjectDocument, bindings: LoadedBindings = new Map()) {
  const originals = new Map(
    Array.from(bindings, ([fileId, binding]) => [binding.id, { fileId, source: binding.source }]),
  )
  const files: Record<string, string> = {}
  const elements: CanvasEl[] = document.elements.map((element) => {
    if (element.type === 'generation')
      return {
        id: element.id,
        type: 'placeholder',
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        status: 'loading',
        message: '',
        meta: {
          taskId: '',
          clientRequestId: element.generationId,
          source: 'builtin-edge',
          prompt: '',
          agent: true,
          cloudGeneration: { id: element.generationId, position: element.position },
        },
      }
    if (element.type !== 'image') return element
    const { mediaId, ...image } = element
    const original = originals.get(mediaId)
    const fileId = original?.fileId ?? `cloud-${mediaId}`
    files[fileId] = original?.source ?? `aip-media:${mediaId}`
    return { ...image, fileId }
  })
  return { elements, files }
}
