import { accountScope } from './authScope'
import { imageDataUrlToPngBlob } from './canvasImage'
import { MediaRequestError, mediaJson } from './cloudMedia'
import { imageMimeFromBytes } from './imageBytes'

export type MediaUploadState = 'queued' | 'uploading' | 'verifying' | 'ready' | 'failed'
export interface MediaUploadResult {
  id: string
  sha256: string
  leaseExpiresAt?: number
}
interface Upload {
  id: string
  status: 'ready' | 'pending'
  uploadUrl?: string
  leaseExpiresAt?: number
}

function slots(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
// Shared by canvas sync and conversation uploads. Confirmation decodes one image at a time.
const uploading = slots(4)
const confirming = slots(1)

async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function uploadMediaSource(
  source: string,
  options: {
    signal: AbortSignal
    purpose?: 'conversation-attachment'
    known?: MediaUploadResult
    uploadMissing?: boolean
    onState?: (state: MediaUploadState) => void
  },
): Promise<MediaUploadResult | undefined> {
  const sameAccount = accountScope()
  const current = () => {
    options.signal.throwIfAborted()
    if (!sameAccount()) throw new Error('media_scope_changed')
  }
  options.onState?.('queued')
  try {
    return await uploading(async () => {
      current()
      if (!source.startsWith('data:image/')) throw new Error('unsupported_local_media')
      const bytes = await (await fetch(source, { signal: options.signal })).arrayBuffer()
      const sha256 = await digest(bytes)
      current()
      if (!options.purpose && options.known?.sha256 === sha256) {
        options.onState?.('ready')
        return options.known
      }
      if (options.uploadMissing === false) return undefined
      let contentType = imageMimeFromBytes(bytes)
      let body = bytes
      if (!contentType) {
        body = await (await imageDataUrlToPngBlob(source)).arrayBuffer()
        contentType = 'image/png'
        current()
      }
      options.onState?.('uploading')
      const upload = await mediaJson<Upload>('/uploads', {
        method: 'POST',
        signal: options.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bytes: body.byteLength,
          contentType,
          sha256: body === bytes ? sha256 : await digest(body),
          ...(options.purpose ? { purpose: options.purpose } : {}),
        }),
      })
      current()
      let leaseExpiresAt = upload.leaseExpiresAt
      if (upload.status !== 'ready') {
        if (!upload.uploadUrl) throw new Error('invalid_media_upload')
        const sent = await fetch(upload.uploadUrl, {
          method: 'PUT',
          credentials: 'omit',
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]),
          headers: { 'content-type': contentType },
          body,
        })
        if (!sent.ok) throw new MediaRequestError(sent.status, 'media_upload_failed')
        current()
        options.onState?.('verifying')
        const complete = await confirming(async () => {
          current()
          return mediaJson<Upload>(`/${upload.id}/complete`, {
            method: 'POST',
            signal: options.signal,
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        })
        if (complete.status !== 'ready' || complete.id !== upload.id)
          throw new Error('invalid_media_confirmation')
        leaseExpiresAt = complete.leaseExpiresAt ?? leaseExpiresAt
      }
      current()
      options.onState?.('ready')
      return { id: upload.id, sha256, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) }
    })
  } catch (error) {
    options.onState?.('failed')
    throw error
  }
}
