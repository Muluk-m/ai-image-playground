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

/** 本地原图读取卡住时按超时失败（映射为 media_timeout），不让上传一直停在排队。 */
const LOCAL_READ_TIMEOUT_MS = 30_000
function withLocalReadTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DOMException('Local attachment read timed out', 'TimeoutError')),
        LOCAL_READ_TIMEOUT_MS,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

type UploadPhase =
  | 'queue'
  | 'read'
  | 'hash'
  | 'convert'
  | 'reserve'
  | 'put'
  | 'confirm_wait'
  | 'confirm'
  | 'confirm_shared'

/**
 * 一张图从排队到确认的分段耗时（毫秒）。在有 product_events 之前先打到控制台的 debug 级
 * （浏览器默认不显示），用 mediaId 能和服务端 media.confirmation_finished 的 phaseMs 对上。
 */
function uploadTimer() {
  const started = performance.now()
  const phaseMs: Partial<Record<UploadPhase, number>> = {}
  let phase: UploadPhase = 'queue'
  let at = started
  const mark = (next: UploadPhase) => {
    const now = performance.now()
    phaseMs[phase] = (phaseMs[phase] ?? 0) + Math.round(now - at)
    phase = next
    at = now
  }
  return {
    mark,
    report(fields: Record<string, unknown>) {
      mark(phase)
      console.debug('[media.upload]', {
        ...fields,
        totalMs: Math.round(performance.now() - started),
        phaseMs,
      })
    },
  }
}

/** 日志里只留错误码，不带后端或浏览器给的原文。 */
function uploadErrorCode(error: unknown): string {
  if (error instanceof MediaRequestError) return error.code
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message)) return error.message
  if (error instanceof Error) return error.name
  return 'unknown'
}

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
  const timer = uploadTimer()
  let bytesSent: number | undefined
  let contentTypeSent: string | undefined
  let mediaId: string | undefined
  let outcome: 'uploaded' | 'known' | 'skipped' = 'uploaded'
  try {
    const result = await uploading(
      async () => {
        current()
        timer.mark('read')
        const local = localAttachmentIdentity(source)
        if (!local && !source.startsWith('data:image/')) throw new Error('unsupported_local_media')
        const bytes = local
          ? (await withLocalReadTimeout(readLocalAttachment(source))).data
          : await (await fetch(source, { signal: options.signal })).arrayBuffer()
        timer.mark('hash')
        const sha256 = await digest(bytes)
        current()
        if (!options.purpose && options.known?.sha256 === sha256) {
          outcome = 'known'
          options.onState?.('ready')
          return options.known
        }
        if (options.uploadMissing === false) {
          outcome = 'skipped'
          return undefined
        }
        // 类型识别、必要时转 PNG 和转码后的再次摘要单独计，不算进 hash。
        timer.mark('convert')
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
        bytesSent = body.byteLength
        contentTypeSent = contentType
        const upload = await transferMedia(
          body,
          contentType,
          body === bytes ? sha256 : await digest(body),
          {
            signal: options.signal,
            current,
            purpose: options.purpose,
            onPhase: timer.mark,
            onReserved: (id) => {
              mediaId = id
            },
            onVerifying: () => {
              timer.mark('confirm_wait')
              options.onState?.('verifying')
            },
            confirm: (work) =>
              confirming(() => {
                timer.mark('confirm')
                return work()
              }),
          },
        )
        const leaseExpiresAt = upload.leaseExpiresAt
        mediaId = upload.id
        current()
        options.onState?.('ready')
        return { id: upload.id, sha256, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) }
      },
      options.purpose === 'conversation-attachment'
        ? (getAttachmentLimits()?.uploadConcurrency ?? 4)
        : 4,
    )
    timer.report({ outcome, mediaId, bytes: bytesSent, contentType: contentTypeSent })
    return result
  } catch (error) {
    if (!options.signal.aborted)
      timer.report({
        outcome: 'failed',
        mediaId,
        bytes: bytesSent,
        contentType: contentTypeSent,
        error: uploadErrorCode(error),
      })
    options.onState?.('failed')
    if (error instanceof TypeError) throw new MediaRequestError(503, 'media_network_error')
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new MediaRequestError(408, 'media_timeout')
    throw error
  }
}
