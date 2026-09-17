import { isProjectDocument, type ProjectDocument } from '@image-playground/shared'
import { scopedStorageName } from '../../../lib/authScope'
import { MediaRequestError, mediaIdentity, mediaJson } from '../../../lib/cloudMedia'
import type { CanvasDoc, CanvasEl } from './canvasDoc'

export interface MediaBinding {
  id: string
  sha256: string
}
export type MediaBindings = Record<string, MediaBinding>
export type LoadedBindings = Map<string, MediaBinding & { source: string }>

export function projectDocument(
  doc: CanvasDoc,
  bindings: LoadedBindings = new Map(),
): ProjectDocument | null {
  const elements = doc.elements.map((element) => {
    if (element.type !== 'image') return element
    const source = doc.files[element.fileId]
    const bound = bindings.get(element.fileId)
    const mediaId = mediaIdentity(source) ?? (bound?.source === source ? bound?.id : undefined)
    if (!mediaId || element.video) return null
    const { fileId: _fileId, ...image } = element
    return { ...image, mediaId }
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
    if (element.type !== 'image' || element.video) continue
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

export function projectScene(document: ProjectDocument) {
  const files: Record<string, string> = {}
  const elements: CanvasEl[] = document.elements.map((element) => {
    if (element.type !== 'image') return element
    const { mediaId, ...image } = element
    const fileId = `cloud-${mediaId}`
    files[fileId] = `aip-media:${mediaId}`
    return { ...image, fileId }
  })
  return { elements, files }
}
