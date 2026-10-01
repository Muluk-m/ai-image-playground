import type { AgentTurnReference } from '@image-playground/shared'
import { isUserStorageScope, scopedStorageName } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { mediaIdentity } from '../../../lib/cloudMedia'
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
  if (!attachmentUploadsEnabled()) return []
  return [reference.dataUrl, ...(reference.maskDataUrl ? [reference.maskDataUrl] : [])].filter(
    (source) => !mediaIdentity(source),
  )
}

export function attachmentUploadState(reference: Uploadable): MediaUploadState | undefined {
  const sources = sourcesToUpload(reference)
  if (!sources.length) return undefined
  const states = sources.map((source) => currentEntries().get(source)?.state ?? 'queued')
  return (['failed', 'uploading', 'verifying', 'queued', 'ready'] as const).find((state) =>
    states.includes(state),
  )
}

export function attachmentUploadError(reference: Uploadable): string | undefined {
  return sourcesToUpload(reference)
    .map((source) => currentEntries().get(source)?.errorCode)
    .find(Boolean)
}

function start(source: string, retry = false): Promise<MediaUploadResult> {
  const cache = currentEntries()
  const previous = cache.get(source)
  const expired =
    previous?.result?.leaseExpiresAt !== undefined &&
    previous.result.leaseExpiresAt <= Date.now() + 30_000
  if (previous && !expired && !(retry && previous.state === 'failed')) return previous.promise
  const controller = new AbortController()
  const entry: Entry = { state: 'queued', controller, promise: undefined! }
  cache.set(source, entry)
  entry.promise = uploadMediaSource(source, {
    signal: controller.signal,
    purpose: 'conversation-attachment',
    onState(state) {
      entry.state = state
      changed()
    },
  })
    .then((result) => {
      if (!result) throw new Error('attachment_upload_missing')
      entry.result = result
      changed()
      pruneEntries()
      return result
    })
    .catch((error: unknown) => {
      entry.errorCode = error instanceof Error ? error.message : 'attachment_upload_failed'
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
  await Promise.all(sourcesToUpload(reference).map((source) => start(source, true)))
}

/** All references belong to one captured turn. A failed member rejects the entire turn. */
export async function prepareAttachmentReferences(
  references: readonly AgentTurnReference[],
): Promise<AgentTurnReference[]> {
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
