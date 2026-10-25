import { type AgentTurnReference, IMAGE_DATA_URL_MAX_CHARS } from '@image-playground/shared'
import { isUserStorageScope, scopedStorageName } from '../../../lib/authScope'
import {
  getAttachmentLimits,
  getMediaLimits,
  isClientCapabilityEnabled,
} from '../../../lib/clientCapabilities'
import { MediaRequestError, mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'
import { BASE_DB_NAME } from '../../../lib/db'
import {
  hasLocalAttachmentSources,
  localAttachmentFailure,
  localAttachmentIdentity,
  onLocalAttachmentReleased,
  onLocalAttachmentUploadChanged,
  readAttachmentUpload,
  saveAttachmentUpload,
} from '../../../lib/localAttachmentSources'
import {
  type MediaUploadResult,
  type MediaUploadState,
  uploadMediaSource,
} from '../../../lib/mediaUpload'
import { getRuntimeConfig } from '../../../lib/runtimeConfig'

type Uploadable = {
  dataUrl: string
  maskDataUrl?: string
  editAction?: unknown
  regions?: readonly unknown[]
}
interface Entry {
  state: MediaUploadState
  result?: MediaUploadResult
  errorCode?: string
  promise: Promise<MediaUploadResult>
  controller: AbortController
}
/** 读本地原图与上传记录不该超过这么久；超时按失败给出重试，不让参考图一直停在排队。 */
export const ATTACHMENT_LOCAL_READ_TIMEOUT_MS = 30_000

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('media_timeout')), ATTACHMENT_LOCAL_READ_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

const entries = new Map<string, Entry>()
const retained = new Map<string, number>()
const listeners = new Set<() => void>()
let scope = ''
let revision = 0
const changed = () => {
  revision++
  for (const listener of listeners) listener()
}
onLocalAttachmentReleased(({ sources, storageScope }) => {
  if (storageScope !== scopedStorageName(BASE_DB_NAME)) return
  let removed = false
  const stillShown: string[] = []
  for (const source of sources) {
    const entry = entries.get(source)
    if (!entry) continue
    entry.controller.abort()
    entries.delete(source)
    removed = true
    if (retained.has(source)) stillShown.push(source)
  }
  if (removed) changed()
  // 草稿还显示着这张图：缺了缓存条目界面会一直显示排队，重新走一遍让它落到真实结果。
  for (const source of stillShown) void start(source).catch(() => {})
})

// Reconcile cached failures from durable truth without starting another upload.
onLocalAttachmentUploadChanged((change) => {
  const backend = getRuntimeConfig().bff.baseUrl
  if (
    change.storageScope !== scopedStorageName(BASE_DB_NAME) ||
    (change.backend !== undefined && change.backend !== backend)
  )
    return
  const cache = currentEntries()
  const ownerScope = scope
  const sources = change.source ? [change.source] : [...cache.keys()]
  for (const source of sources) {
    const previous = cache.get(source)
    if (!previous) continue
    void readAttachmentUpload(source, backend)
      .then((saved) => {
        if (
          scope !== ownerScope ||
          change.storageScope !== scopedStorageName(BASE_DB_NAME) ||
          backend !== getRuntimeConfig().bff.baseUrl ||
          cache.get(source) !== previous
        )
          return
        if (
          saved?.state === 'ready' &&
          saved.result.leaseExpiresAt !== undefined &&
          saved.result.leaseExpiresAt > Date.now() + 30_000
        ) {
          if (
            previous.state === 'ready' &&
            previous.result?.id === saved.result.id &&
            previous.result.leaseExpiresAt === saved.result.leaseExpiresAt
          )
            return
          previous.controller.abort()
          cache.set(source, {
            state: 'ready',
            result: saved.result,
            controller: new AbortController(),
            promise: Promise.resolve(saved.result),
          })
          changed()
        } else if (
          saved?.state === 'failed' &&
          (previous.state === 'ready' || previous.state === 'failed') &&
          (previous.state !== 'failed' || previous.errorCode !== saved.errorCode)
        ) {
          previous.controller.abort()
          const promise = Promise.reject<MediaUploadResult>(new Error(saved.errorCode))
          void promise.catch(() => {})
          cache.set(source, {
            state: 'failed',
            errorCode: saved.errorCode,
            controller: new AbortController(),
            promise,
          })
          changed()
        }
      })
      .catch(() => {})
  }
})

export const subscribeAttachmentUploads = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const attachmentUploadRevision = () => revision

export function attachmentUploadsEnabled(): boolean {
  return (
    getRuntimeConfig().bff.enabled &&
    isUserStorageScope() &&
    isClientCapabilityEnabled('agent:attachments')
  )
}

/**
 * 对话附件那条通道没开（测试环境就是这样），但已登录、开着云同步：内联有 4,000,000 字符的
 * 请求体上限，大图和遮罩改按普通云媒体上传、按 id 发——与画布云项目的原图同一条通道，
 * 原件字节不缩、不重编码。
 */
export function mediaFallbackEnabled(): boolean {
  return (
    !attachmentUploadsEnabled() &&
    getRuntimeConfig().bff.enabled &&
    isUserStorageScope() &&
    getMediaLimits() !== undefined
  )
}

/** 选图时就要拦的那道单张上限；数值都来自服务端下发的配置，不在前端写死。 */
export interface ReferenceImageLimit {
  readonly imageBytes: number
  /** true：超过内联上限也能按 id 发；false：只能内联，上限就是请求体那道。 */
  readonly byId: boolean
}

export function referenceImageLimit(): ReferenceImageLimit {
  const attachments = attachmentUploadsEnabled() ? getAttachmentLimits() : undefined
  if (attachments) return { imageBytes: attachments.imageBytes, byId: true }
  const media = mediaFallbackEnabled() ? getMediaLimits() : undefined
  if (media) return { imageBytes: media.imageBytes, byId: true }
  return { imageBytes: Math.floor((IMAGE_DATA_URL_MAX_CHARS - 64) / 4) * 3, byId: false }
}

/** data URL 解出来的字节数；不是 data URL（云媒体、本机句柄）返回 undefined。 */
export function dataUrlBytes(source: string): number | undefined {
  if (!source.startsWith('data:')) return undefined
  const comma = source.indexOf(',')
  if (comma < 0) return undefined
  const body = source.length - comma - 1
  if (!source.slice(0, comma).endsWith(';base64')) return body
  const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0
  return Math.floor((body * 3) / 4) - padding
}

export const REFERENCE_TOO_LARGE = 'reference_too_large'

/**
 * 这张图发不出去：附件通道之外，按 id 发时超过云媒体单张上限，只能内联时超过请求体上限。
 * 附件通道开着时由那条上传流水线自己报失败，这里不重复判断。
 */
export function oversizedReferenceSource(source: string): boolean {
  return !attachmentUploadsEnabled() && referenceSourceTooLarge(source)
}

/** 不论走哪条通道，这份 data URL 都超过了这一档部署的单张上限。首屏输入框按它在选图时就拦。 */
export function referenceSourceTooLarge(source: string): boolean {
  const bytes = dataUrlBytes(source)
  if (bytes === undefined) return false
  const limit = referenceImageLimit()
  return limit.byId ? bytes > limit.imageBytes : source.length > IMAGE_DATA_URL_MAX_CHARS
}

function localAttachmentsEnabled(): boolean {
  return attachmentUploadsEnabled() && isClientCapabilityEnabled('agent:bulk-attachments')
}

function blockedLocalAttachments(value: unknown): boolean {
  return hasLocalAttachmentSources(value) && !localAttachmentsEnabled()
}

function currentEntries() {
  const current = scopedStorageName(`agent-attachments:${getRuntimeConfig().bff.baseUrl}`)
  if (current !== scope) {
    for (const entry of entries.values()) entry.controller.abort()
    entries.clear()
    retained.clear()
    scope = current
  }
  return entries
}

function sourcesToUpload(reference: Uploadable): string[] {
  if (!attachmentUploadsEnabled() || blockedLocalAttachments(reference)) return []
  return [reference.dataUrl, ...(reference.maskDataUrl ? [reference.maskDataUrl] : [])].filter(
    (source) => !mediaIdentity(source),
  )
}

export function attachmentUploadState(reference: Uploadable): MediaUploadState | undefined {
  if (blockedLocalAttachments(reference)) return 'failed'
  if (oversizedReferenceSource(reference.dataUrl)) return 'failed'
  const sources = sourcesToUpload(reference)
  if (!sources.length) return undefined
  const states = sources.map((source) => currentEntries().get(source)?.state ?? 'queued')
  return (['failed', 'uploading', 'verifying', 'queued', 'ready'] as const).find((state) =>
    states.includes(state),
  )
}

export function attachmentUploadError(reference: Uploadable): string | undefined {
  if (blockedLocalAttachments(reference)) return 'attachment_capability_unavailable'
  if (oversizedReferenceSource(reference.dataUrl)) return REFERENCE_TOO_LARGE
  return sourcesToUpload(reference)
    .map((source) => currentEntries().get(source)?.errorCode)
    .find(Boolean)
}

function start(source: string, retry = false): Promise<MediaUploadResult> {
  const enforceLocalCapability = () => {
    if (
      (localAttachmentIdentity(source) || localAttachmentFailure(source)) &&
      !localAttachmentsEnabled()
    )
      throw new Error('attachment_capability_unavailable')
  }
  try {
    enforceLocalCapability()
  } catch (error) {
    return Promise.reject(error)
  }
  const cache = currentEntries()
  const previous = cache.get(source)
  const expired =
    previous?.result?.leaseExpiresAt !== undefined &&
    previous.result.leaseExpiresAt <= Date.now() + 30_000
  if (
    previous &&
    !expired &&
    previous.errorCode !== 'attachment_capability_unavailable' &&
    !(retry && previous.state === 'failed')
  )
    return previous.promise
  const controller = new AbortController()
  const entry: Entry = { state: 'queued', controller, promise: undefined! }
  cache.set(source, entry)
  const backend = getRuntimeConfig().bff.baseUrl
  const ownerScope = scope
  entry.promise = (async () => {
    const saved = await bounded(readAttachmentUpload(source, backend))
    controller.signal.throwIfAborted()
    enforceLocalCapability()
    if (saved?.state === 'failed' && (!retry || localAttachmentFailure(source)))
      throw new Error(saved.errorCode)
    if (
      saved?.state === 'ready' &&
      saved.result.leaseExpiresAt !== undefined &&
      saved.result.leaseExpiresAt > Date.now() + 30_000
    ) {
      entry.state = 'ready'
      entry.result = saved.result
      changed()
      pruneEntries()
      return saved.result
    }
    const result = await uploadMediaSource(source, {
      signal: controller.signal,
      purpose: 'conversation-attachment',
      onState(state) {
        if (state === 'ready' || state === 'failed') return
        entry.state = state
        changed()
      },
    })
    if (!result) throw new Error('attachment_upload_missing')
    // 记录写不进去不影响这次上传已经就绪；下次按租约重新确认即可。
    await bounded(saveAttachmentUpload(source, backend, { state: 'ready', result })).catch(() => {})
    controller.signal.throwIfAborted()
    entry.result = result
    entry.state = 'ready'
    changed()
    pruneEntries()
    return result
  })().catch(async (error: unknown) => {
    const errorCode = error instanceof Error ? error.message : 'attachment_upload_failed'
    if (!controller.signal.aborted && errorCode !== 'attachment_capability_unavailable')
      await bounded(saveAttachmentUpload(source, backend, { state: 'failed', errorCode })).catch(
        () => {},
      )
    // Callers may already hold this promise when another page finishes the same source.
    // Reuse its durable success, but never revive a released or differently scoped source.
    if (scope === ownerScope && backend === getRuntimeConfig().bff.baseUrl && cache.has(source)) {
      const saved = await bounded(readAttachmentUpload(source, backend)).catch(() => undefined)
      if (
        scope === ownerScope &&
        backend === getRuntimeConfig().bff.baseUrl &&
        cache.has(source) &&
        saved?.state === 'ready' &&
        saved.result.leaseExpiresAt !== undefined &&
        saved.result.leaseExpiresAt > Date.now() + 30_000
      ) {
        enforceLocalCapability()
        entry.result = saved.result
        entry.state = 'ready'
        entry.errorCode = undefined
        changed()
        return saved.result
      }
    }
    entry.errorCode = errorCode
    entry.state = 'failed'
    changed()
    throw error
  })
  return entry.promise
}

function pruneEntries() {
  for (const [source, entry] of entries) {
    if (entries.size <= 64) break
    if (!retained.has(source) && (entry.state === 'ready' || entry.state === 'failed'))
      entries.delete(source)
  }
}

/** A mounted draft or preparing snapshot owns its cache entries until it releases this lease. */
export function primeAttachmentUploads(references: readonly Uploadable[]): () => void {
  currentEntries()
  const ownerScope = scope
  const sources = new Set(references.flatMap(sourcesToUpload))
  for (const source of sources) retained.set(source, (retained.get(source) ?? 0) + 1)
  for (const source of sources) void start(source).catch(() => {})
  return () => {
    if (scope !== ownerScope) return
    for (const source of sources) {
      const count = retained.get(source) ?? 0
      if (count > 1) retained.set(source, count - 1)
      else retained.delete(source)
    }
    // React replaces the previous effect lease synchronously before this eviction runs.
    queueMicrotask(pruneEntries)
  }
}

export function canReuseAttachmentMedia(reference: Uploadable): boolean {
  return !reference.maskDataUrl && !reference.editAction && !reference.regions?.length
}

export function withKnownAttachmentMedia<T extends Uploadable>(
  reference: T,
  lookup: (source: string) => string | undefined,
): T {
  if (!canReuseAttachmentMedia(reference)) return reference
  const id = lookup(reference.dataUrl)
  return id ? { ...reference, dataUrl: `aip-media:${id}` } : reference
}

export function retryAttachmentUpload(source: string): Promise<MediaUploadResult> {
  if (!attachmentUploadsEnabled())
    return Promise.reject(new Error('attachment_uploads_unavailable'))
  return start(source, true)
}

export async function retryAttachmentUploads(reference: Uploadable): Promise<void> {
  if (blockedLocalAttachments(reference)) throw new Error('attachment_capability_unavailable')
  await Promise.all(sourcesToUpload(reference).map((source) => start(source, true)))
}

/** All references belong to one captured turn. A failed member rejects the entire turn. */
export async function prepareAttachmentReferences(
  references: readonly AgentTurnReference[],
): Promise<AgentTurnReference[]> {
  if (blockedLocalAttachments(references)) throw new Error('attachment_capability_unavailable')
  if (mediaFallbackEnabled()) return await Promise.all(references.map(sendableById))
  const release = primeAttachmentUploads(references.filter((reference) => 'dataUrl' in reference))
  try {
    const prepared = await Promise.allSettled(
      references.map(async (reference) => {
        if (!('dataUrl' in reference) || !attachmentUploadsEnabled()) return reference
        const identity = async (source: string) => mediaIdentity(source) ?? (await start(source)).id
        const [mediaId, maskMediaId] = await Promise.all([
          identity(reference.dataUrl),
          reference.maskDataUrl ? identity(reference.maskDataUrl) : undefined,
        ])
        const { dataUrl: _source, maskDataUrl: _mask, ...rest } = reference
        return { ...rest, mediaId, ...(maskMediaId ? { maskMediaId } : {}) }
      }),
    )
    return prepared.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
  } finally {
    release()
  }
}

/**
 * 附件通道关着时的一张参考图：放得进内联的照旧内联；放不进的（大图、或原件已在云端而遮罩是新画的）
 * 把还不在云端的那几份按普通云媒体上传，整条按 id 发。原件不缩、不重编码。
 */
async function sendableById(reference: AgentTurnReference): Promise<AgentTurnReference> {
  if (!('dataUrl' in reference)) return reference
  const sourceId = mediaIdentity(reference.dataUrl)
  const maskId = reference.maskDataUrl ? mediaIdentity(reference.maskDataUrl) : undefined
  const original = sourceId ? undefined : await resolveMediaSource(reference.dataUrl)
  const mask =
    reference.maskDataUrl && !maskId ? await resolveMediaSource(reference.maskDataUrl) : undefined
  const tooLong = (source: string | undefined) => (source?.length ?? 0) > IMAGE_DATA_URL_MAX_CHARS
  const byId =
    Boolean(sourceId && reference.maskDataUrl) ||
    Boolean(maskId) ||
    tooLong(original) ||
    tooLong(mask)
  if (!byId) return reference
  const limit = getMediaLimits()
  const signal = AbortSignal.timeout(180_000)
  const upload = async (source: string) => {
    const bytes = dataUrlBytes(source)
    if (limit && bytes !== undefined && bytes > limit.imageBytes)
      throw new MediaRequestError(413, 'media_too_large')
    const result = await uploadMediaSource(source, { signal })
    if (!result) throw new MediaRequestError(500, 'media_upload_failed')
    return result.id
  }
  const [mediaId, maskMediaId] = await Promise.all([
    sourceId ?? upload(original!),
    maskId ?? (mask ? upload(mask) : undefined),
  ])
  const { dataUrl: _source, maskDataUrl: _mask, ...rest } = reference
  return { ...rest, mediaId, ...(maskMediaId ? { maskMediaId } : {}) }
}
