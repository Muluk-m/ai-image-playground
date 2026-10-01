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
  promise: Promise<MediaUploadResult>
  controller: AbortController
}
const entries = new Map<string, Entry>()
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
    scope = current
  }
  return entries
}

function requiresUpload(reference: Uploadable): boolean {
  return (
    attachmentUploadsEnabled() &&
    !reference.maskDataUrl &&
    !reference.editAction &&
    !reference.regions?.length &&
    !mediaIdentity(reference.dataUrl)
  )
}

export function attachmentUploadState(reference: Uploadable): MediaUploadState | undefined {
  if (!requiresUpload(reference)) return undefined
  return currentEntries().get(reference.dataUrl)?.state ?? 'queued'
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
  }).then((result) => {
    if (!result) throw new Error('attachment_upload_missing')
    entry.result = result
    changed()
    // Draft pixels live in the draft store; keep only a bounded upload cache in memory.
    if (cache.size > 64) {
      for (const [key, value] of cache) {
        if (cache.size <= 64) break
        if (key !== source && (value.state === 'ready' || value.state === 'failed'))
          cache.delete(key)
      }
    }
    return result
  })
  return entry.promise
}

export function primeAttachmentUploads(references: readonly Uploadable[]): void {
  for (const reference of references) {
    if (requiresUpload(reference)) void start(reference.dataUrl).catch(() => {})
  }
}

export function retryAttachmentUpload(source: string): Promise<MediaUploadResult> {
  if (!attachmentUploadsEnabled())
    return Promise.reject(new Error('attachment_uploads_unavailable'))
  return start(source, true)
}

/** All references belong to one captured turn. A failed member rejects the entire turn. */
export async function prepareAttachmentReferences(
  references: readonly AgentTurnReference[],
): Promise<AgentTurnReference[]> {
  const prepared = await Promise.allSettled(
    references.map(async (reference) => {
      if (!('dataUrl' in reference) || !requiresUpload(reference)) return reference
      const result = await start(reference.dataUrl)
      return {
        imageId: reference.imageId,
        mediaId: result.id,
        ...(reference.name ? { name: reference.name } : {}),
      }
    }),
  )
  return prepared.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}
