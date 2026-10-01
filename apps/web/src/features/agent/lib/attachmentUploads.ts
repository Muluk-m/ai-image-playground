import type { AgentTurnReference } from '@image-playground/shared'
import { isUserStorageScope, scopedStorageName } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { mediaIdentity } from '../../../lib/cloudMedia'
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
  for (const source of sources) {
    const entry = entries.get(source)
    if (!entry) continue
    entry.controller.abort()
    entries.delete(source)
    removed = true
  }
  if (removed) changed()
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
  const sources = sourcesToUpload(reference)
  if (!sources.length) return undefined
  const states = sources.map((source) => currentEntries().get(source)?.state ?? 'queued')
  return (['failed', 'uploading', 'verifying', 'queued', 'ready'] as const).find((state) =>
    states.includes(state),
  )
}

export function attachmentUploadError(reference: Uploadable): string | undefined {
  if (blockedLocalAttachments(reference)) return 'attachment_capability_unavailable'
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
  entry.promise = (async () => {
    const saved = await readAttachmentUpload(source, backend)
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
    await saveAttachmentUpload(source, backend, { state: 'ready', result })
    controller.signal.throwIfAborted()
    entry.result = result
    entry.state = 'ready'
    changed()
    pruneEntries()
    return result
  })().catch(async (error: unknown) => {
    const errorCode = error instanceof Error ? error.message : 'attachment_upload_failed'
    if (!controller.signal.aborted && errorCode !== 'attachment_capability_unavailable')
      await saveAttachmentUpload(source, backend, { state: 'failed', errorCode }).catch(() => {})
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
