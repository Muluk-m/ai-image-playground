import { accountScope } from './authScope'
import { imageDataUrlToPngBlob } from './canvasImage'
import { getAttachmentLimits } from './clientCapabilities'
import { MediaRequestError } from './cloudMedia'
import { imageMimeFromBytes } from './imageBytes'
import { localAttachmentIdentity, readLocalAttachment } from './localAttachmentSources'
import { transferMedia } from './mediaTransfer'
import { bffBaseUrl } from './runtimeConfig'

export type MediaUploadState = 'queued' | 'uploading' | 'verifying' | 'ready' | 'failed'
export interface MediaUploadResult {
  id: string
  sha256: string
  leaseExpiresAt?: number
}

function slots(limit: number) {
  let active = 0
  const waiting: { limit: number; resume: () => void }[] = []
  const drain = () => {
    while (waiting.length && active < Math.min(limit, waiting[0]!.limit)) {
      active++
      waiting.shift()!.resume()
    }
  }
  return async <T>(work: () => Promise<T>, requestedLimit = limit): Promise<T> => {
    await new Promise<void>((resume) => {
      waiting.push({ limit: requestedLimit, resume })
      drain()
    })
    try {
      return await work()
    } finally {
      active--
      drain()
    }
  }
}
// Keep original buffering bounded while two confirmations overlap storage I/O.
const uploading = slots(4)
const confirming = slots(2)

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
  const backend = bffBaseUrl()
  const current = () => {
    options.signal.throwIfAborted()
    if (!sameAccount() || backend !== bffBaseUrl()) throw new Error('media_scope_changed')
  }
  options.onState?.('queued')
  try {
    return await uploading(
      async () => {
        current()
        const local = localAttachmentIdentity(source)
        if (!local && !source.startsWith('data:image/')) throw new Error('unsupported_local_media')
        const bytes = local
          ? (await readLocalAttachment(source)).data
          : await (await fetch(source, { signal: options.signal })).arrayBuffer()
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
          if (options.purpose === 'conversation-attachment')
            throw new MediaRequestError(422, 'media_unsupported_image')
          body = await (await imageDataUrlToPngBlob(source)).arrayBuffer()
          contentType = 'image/png'
          current()
        }
        options.onState?.('uploading')
        const upload = await transferMedia(
          body,
          contentType,
          body === bytes ? sha256 : await digest(body),
          {
            signal: options.signal,
            current,
            purpose: options.purpose,
            onVerifying: () => options.onState?.('verifying'),
            confirm: (work) => confirming(work),
          },
        )
        const leaseExpiresAt = upload.leaseExpiresAt
        current()
        options.onState?.('ready')
        return { id: upload.id, sha256, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) }
      },
      options.purpose === 'conversation-attachment'
        ? (getAttachmentLimits()?.uploadConcurrency ?? 4)
        : 4,
    )
  } catch (error) {
    options.onState?.('failed')
    if (error instanceof TypeError) throw new MediaRequestError(503, 'media_network_error')
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new MediaRequestError(408, 'media_timeout')
    throw error
  }
}
