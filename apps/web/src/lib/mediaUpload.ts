import { accountScope, safeLocalStorage } from './authScope'
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
// 同时传 4 张，确认也 4 张并行：服务端每实例同样处理 4 张（存储 I/O 重叠，解码一次一张）。
const uploading = slots(4)
const confirming = slots(4)

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
 * 一张图从排队到确认的分段耗时（毫秒）。在有 product_events 之前，只在本机打开
 * localStorage `MEDIA_UPLOAD_TIMING_FLAG` = '1' 时打到控制台 debug 级；默认什么都不输出。
 * 用 mediaId 能和服务端 media.confirmation_finished 的 phaseMs 对上。
 */
export const MEDIA_UPLOAD_TIMING_FLAG = 'debug.mediaUploadTiming'

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
      if (safeLocalStorage.getItem(MEDIA_UPLOAD_TIMING_FLAG) !== '1') return
      console.debug('[media.upload]', {
        ...fields,
        totalMs: Math.round(performance.now() - started),
        phaseMs,
      })
    },
  }
}

/** 日志里只留形如错误码的值，不带后端或浏览器给的原文。 */
function uploadErrorCode(error: unknown): string {
  const code = /^[a-z][a-z0-9_]{0,63}$/
  if (error instanceof MediaRequestError)
    return code.test(error.code) ? error.code : 'media_request_failed'
  if (error instanceof Error && code.test(error.message)) return error.message
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
        // 0 字节、改了扩展名的文本：这份字节再传多少次都不是图，按服务端同一个错误码报，调用方可据此判定永久失败。
        if (bytes.byteLength === 0) throw new MediaRequestError(422, 'media_invalid_image')
        // 类型识别、必要时转 PNG 和转码后的再次摘要单独计，不算进 hash。
        timer.mark('convert')
        let contentType = imageMimeFromBytes(bytes)
        let body = bytes
        if (!contentType) {
          if (options.purpose === 'conversation-attachment')
            throw new MediaRequestError(422, 'media_unsupported_image')
          // 只有浏览器解不出这份字节才算坏图；解出来后转 PNG 失败（画布、内存）是本机问题，照常按可重试报。
          let decoded: Blob
          try {
            decoded = await imageDataUrlToPngBlob(source)
          } catch (error) {
            // 与 canvasImage 的 IMAGE_DECODE_FAILED 同值；不直接引常量，测试里整模块替换 canvasImage 时也成立。
            if ((error as { code?: unknown } | null)?.code === 'image_decode_failed')
              throw new MediaRequestError(422, 'media_invalid_image')
            throw error
          }
          body = await decoded.arrayBuffer()
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
  } catch (caught) {
    let error = caught
    if (caught instanceof TypeError) error = new MediaRequestError(503, 'media_network_error')
    else if (caught instanceof DOMException && caught.name === 'TimeoutError')
      error = new MediaRequestError(408, 'media_timeout')
    if (!options.signal.aborted)
      timer.report({
        outcome: 'failed',
        mediaId,
        bytes: bytesSent,
        contentType: contentTypeSent,
        error: uploadErrorCode(error),
      })
    options.onState?.('failed')
    throw error
  }
}
