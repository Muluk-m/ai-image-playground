import { accountScope, scopedStorageName } from './authScope'
import {
  BASE_DB_NAME,
  openNamedDb,
  STORE_ATTACHMENT_METADATA,
  STORE_ATTACHMENT_OWNERS,
  STORE_ATTACHMENT_SOURCES,
} from './db'
import type { MediaUploadResult } from './mediaUpload'

interface StoredSource {
  id: string
  data: ArrayBuffer
  contentType: string
}

export function localAttachmentIdentity(source: string): string | undefined {
  return /^aip-local:([0-9a-f-]{36})$/i.exec(source)?.[1]
}

function fileBytes(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

export function localAttachmentFailure(source: string): string | undefined {
  return /^aip-local-failed:(attachment_storage_failed):[0-9a-f-]{36}$/i.exec(source)?.[1]
}

interface PendingSource {
  reserved: Promise<void>
  settled: Promise<void>
}
const pendingSources = new Map<string, PendingSource>()
const writerId = crypto.randomUUID()
const writerLeases = new Map<string, Promise<void>>()

function locks(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks
}

function writerLease(dbName: string): Promise<void> {
  const manager = locks()
  if (!manager) return Promise.resolve()
  let lease = writerLeases.get(dbName)
  if (!lease) {
    lease = new Promise<void>((resolve, reject) => {
      void manager
        .request(`attachment-writer:${dbName}:${writerId}`, async () => {
          resolve()
          // The browser releases the lease when this page terminates, including a crash.
          await new Promise<void>(() => {})
        })
        .catch(reject)
    })
    writerLeases.set(dbName, lease)
  }
  return lease
}

/** Serialize durable document handoffs with recovery across tabs, never across network work. */
export async function withAttachmentDocumentLock<T>(
  work: () => Promise<T>,
  dbName = scopedStorageName(BASE_DB_NAME),
): Promise<T> {
  return await (locks()?.request(`attachment-documents:${dbName}`, work) ?? work())
}
let sourceWriter = Promise.resolve()

/** Register existing canvas/library pixels without copying them into a draft or decoding the queue. */
export function registerLocalAttachmentSource(source: string | File, maxBytes: number): string {
  if (typeof source === 'string' && !source.startsWith('data:image/')) return source
  const id = crypto.randomUUID()
  const handle = `aip-local:${id}`
  const current = accountScope()
  const dbName = scopedStorageName(BASE_DB_NAME)
  const reserved = (async () => {
    await writerLease(dbName)
    const db = await openNamedDb(dbName)
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ATTACHMENT_METADATA, 'readwrite')
        tx.objectStore(STORE_ATTACHMENT_METADATA).put({
          id,
          bytes: 0,
          createdAt: Date.now(),
          errorCode: 'attachment_read_interrupted',
          writerId,
        } satisfies SourceMetadata)
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })()
  // Queue only the existing immutable source. Exactly one source allocates decoded bytes at a time.
  const settled = sourceWriter
    .then(async () => {
      await reserved
      if (!current()) return
      let data: ArrayBuffer | undefined
      let errorCode: string | undefined
      const encoded =
        typeof source === 'string' && source.slice(0, source.indexOf(',')).endsWith(';base64')
      const estimatedBytes =
        typeof source !== 'string'
          ? source.size
          : encoded
            ? Math.floor(((source.length - source.indexOf(',') - 1) * 3) / 4)
            : source.length
      if (estimatedBytes > maxBytes + (encoded ? 2 : 0)) errorCode = 'media_image_too_large'
      else {
        try {
          data =
            typeof source === 'string'
              ? await (await fetch(source)).arrayBuffer()
              : await fileBytes(source)
          if (data.byteLength > maxBytes) {
            data = undefined
            errorCode = 'media_image_too_large'
          }
        } catch {
          errorCode = 'attachment_read_failed'
        }
      }
      if (!current()) return
      const db = await openNamedDb(dbName)
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            [STORE_ATTACHMENT_SOURCES, STORE_ATTACHMENT_METADATA],
            'readwrite',
          )
          const metadata = tx.objectStore(STORE_ATTACHMENT_METADATA)
          const request = metadata.get(id)
          request.onsuccess = () => {
            const row = request.result as SourceMetadata | undefined
            // A removed draft can release this original while the read is in progress.
            if (!row) return
            try {
              if (data)
                tx.objectStore(STORE_ATTACHMENT_SOURCES).put({
                  id,
                  data,
                  contentType:
                    typeof source === 'string' ? source.slice(5, source.indexOf(';')) : source.type,
                } satisfies StoredSource)
              const { errorCode: _pending, ...rest } = row
              metadata.put({
                ...rest,
                bytes: data?.byteLength ?? 0,
                ...(errorCode ? { errorCode } : {}),
              })
            } catch {
              tx.abort()
            }
          }
          tx.oncomplete = () => resolve()
          tx.onabort = tx.onerror = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    })
    .catch(async () => {
      // Metadata may still fit when writing the original failed; otherwise a missing source is failed.
      const db = await openNamedDb(dbName).catch(() => undefined)
      if (!db) return
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_ATTACHMENT_METADATA, 'readwrite')
          const store = tx.objectStore(STORE_ATTACHMENT_METADATA)
          const read = store.get(id)
          read.onsuccess = () => {
            if (read.result) store.put({ ...read.result, errorCode: 'attachment_storage_failed' })
          }
          tx.oncomplete = () => resolve()
          tx.onabort = tx.onerror = () => reject(tx.error)
        })
      } catch {
        /* The durable draft still retains the failed position. */
      } finally {
        db.close()
      }
    })
  sourceWriter = settled
  pendingSources.set(handle, { reserved, settled })
  void reserved.catch(() => {})
  void settled.finally(() => {
    pendingSources.delete(handle)
  })
  return handle
}

export async function readLocalAttachment(source: string): Promise<StoredSource> {
  const id = localAttachmentIdentity(source)
  if (!id) throw new Error('unsupported_local_media')
  const current = accountScope()
  await pendingSources.get(source)?.settled
  if (!current()) throw new Error('media_scope_changed')
  const db = await openNamedDb(scopedStorageName(BASE_DB_NAME))
  try {
    const row = await new Promise<StoredSource | undefined>((resolve, reject) => {
      const tx = db.transaction([STORE_ATTACHMENT_SOURCES, STORE_ATTACHMENT_METADATA])
      const metadata = tx.objectStore(STORE_ATTACHMENT_METADATA).get(id)
      metadata.onsuccess = () => {
        const errorCode = (metadata.result as SourceMetadata | undefined)?.errorCode
        if (errorCode) {
          reject(new Error(errorCode))
          return
        }
        const request = tx.objectStore(STORE_ATTACHMENT_SOURCES).get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }
      metadata.onerror = () => reject(metadata.error)
    })
    if (!current()) throw new Error('media_scope_changed')
    if (!row) throw new Error('attachment_source_missing')
    return row
  } finally {
    db.close()
  }
}

/** Compare one immutable local original with the source captured from the canvas at submit time. */
let comparingSources = Promise.resolve()
export function localAttachmentMatchesSource(
  handle: string,
  capturedSource: string,
): Promise<boolean> {
  const current = accountScope()
  const result = comparingSources.then(async () => {
    if (!current()) throw new Error('media_scope_changed')
    if (!capturedSource.startsWith('data:image/')) return false
    const original = new Uint8Array((await readLocalAttachment(handle)).data)
    const comma = capturedSource.indexOf(',')
    if (
      capturedSource.slice(0, comma).endsWith(';base64') &&
      Math.abs(Math.floor(((capturedSource.length - comma - 1) * 3) / 4) - original.length) > 2
    )
      return false
    const candidate = new Uint8Array(await (await fetch(capturedSource)).arrayBuffer())
    if (!current()) throw new Error('media_scope_changed')
    return (
      original.length === candidate.length &&
      original.every((byte, index) => byte === candidate[index])
    )
  })
  comparingSources = result.then(
    () => {},
    () => {},
  )
  return result
}

export type StoredAttachmentUpload =
  | { state: 'ready'; result: MediaUploadResult }
  | { state: 'failed'; errorCode: string }

interface SourceMetadata {
  writerId?: string
  id: string
  bytes: number
  createdAt: number
  errorCode?: string
  owners?: string[]
  uploads?: Record<string, StoredAttachmentUpload>
}

export async function readAttachmentUpload(
  source: string,
  backend: string,
): Promise<StoredAttachmentUpload | undefined> {
  const failure = localAttachmentFailure(source)
  if (failure) return { state: 'failed', errorCode: failure }
  const id = localAttachmentIdentity(source)
  if (!id) return undefined
  const current = accountScope()
  await pendingSources.get(source)?.settled
  if (!current()) throw new Error('media_scope_changed')
  const db = await openNamedDb(scopedStorageName(BASE_DB_NAME))
  try {
    const row = await new Promise<SourceMetadata | undefined>((resolve, reject) => {
      const request = db
        .transaction(STORE_ATTACHMENT_METADATA)
        .objectStore(STORE_ATTACHMENT_METADATA)
        .get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!current()) throw new Error('media_scope_changed')
    return !row
      ? { state: 'failed', errorCode: 'attachment_source_missing' }
      : row.errorCode
        ? { state: 'failed', errorCode: row.errorCode }
        : row.uploads?.[backend]
  } finally {
    db.close()
  }
}

interface AttachmentUploadChange {
  readonly source?: string
  readonly backend?: string
  readonly storageScope: string
}
const uploadListeners = new Set<(change: AttachmentUploadChange) => void>()

export function onLocalAttachmentUploadChanged(
  listener: (change: AttachmentUploadChange) => void,
): () => void {
  uploadListeners.add(listener)
  watchAttachmentChanges()
  return () => {
    uploadListeners.delete(listener)
    stopWatchingAttachmentChanges()
  }
}

/** The ready indicator is published only after its lease can survive a reload. */
export async function saveAttachmentUpload(
  source: string,
  backend: string,
  upload: StoredAttachmentUpload,
): Promise<void> {
  const id = localAttachmentIdentity(source)
  if (!id) return
  const current = accountScope()
  await pendingSources.get(source)?.settled
  if (!current()) throw new Error('media_scope_changed')
  const db = await openNamedDb(scopedStorageName(BASE_DB_NAME))
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ATTACHMENT_METADATA, 'readwrite')
      const store = tx.objectStore(STORE_ATTACHMENT_METADATA)
      const request = store.get(id)
      request.onsuccess = () => {
        const row = request.result as SourceMetadata | undefined
        if (!row || !current()) {
          tx.abort()
          return
        }
        const previous = row.uploads?.[backend]
        // A slower page's failure cannot revoke another page's still-valid upload lease.
        if (
          upload.state === 'failed' &&
          previous?.state === 'ready' &&
          previous.result.leaseExpiresAt !== undefined &&
          previous.result.leaseExpiresAt > Date.now()
        )
          return
        store.put({ ...row, uploads: { ...row.uploads, [backend]: upload } })
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('attachment_source_missing'))
    })
    if (!current()) throw new Error('media_scope_changed')
    publishAttachmentChange({
      kind: 'upload',
      source,
      backend,
      storageScope: scopedStorageName(BASE_DB_NAME),
    })
  } finally {
    db.close()
  }
}

interface ReleasedAttachments {
  readonly sources: readonly string[]
  readonly storageScope: string
}
const releaseListeners = new Set<(release: ReleasedAttachments) => void>()

export function onLocalAttachmentReleased(
  listener: (release: ReleasedAttachments) => void,
): () => void {
  releaseListeners.add(listener)
  watchAttachmentChanges()
  return () => {
    releaseListeners.delete(listener)
    stopWatchingAttachmentChanges()
  }
}

type AttachmentChange =
  | (AttachmentUploadChange & { kind: 'upload'; source: string; backend: string })
  | (ReleasedAttachments & { kind: 'release' })
let changeChannel: BroadcastChannel | undefined
let channelScope: string | undefined
let watchingChanges = false
let pageHidden = false

function receiveAttachmentChange(change: AttachmentChange) {
  if (change.storageScope !== scopedStorageName(BASE_DB_NAME)) return
  if (change.kind === 'upload') {
    for (const listener of uploadListeners) listener(change)
  } else {
    for (const listener of releaseListeners) listener(change)
  }
}

function closeChangeChannel() {
  changeChannel?.close()
  changeChannel = undefined
  channelScope = undefined
}

function connectChangeChannel() {
  const storageScope = scopedStorageName(BASE_DB_NAME)
  if (changeChannel && channelScope !== storageScope) closeChangeChannel()
  if (changeChannel || pageHidden || typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(`attachment-changes:${storageScope}`)
    channelScope = storageScope
    changeChannel = channel
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (
        !data ||
        typeof data !== 'object' ||
        !('storageScope' in data) ||
        data.storageScope !== storageScope ||
        !('kind' in data)
      )
        return
      if (
        data.kind === 'upload' &&
        'source' in data &&
        typeof data.source === 'string' &&
        localAttachmentIdentity(data.source) &&
        'backend' in data &&
        typeof data.backend === 'string'
      )
        receiveAttachmentChange({
          kind: 'upload',
          storageScope,
          source: data.source,
          backend: data.backend,
        })
      else if (
        data.kind === 'release' &&
        'sources' in data &&
        Array.isArray(data.sources) &&
        data.sources.every(
          (source) => typeof source === 'string' && localAttachmentIdentity(source),
        )
      )
        receiveAttachmentChange({ kind: 'release', storageScope, sources: data.sources })
    }
  } catch {
    /* Page activation still rechecks IndexedDB when browser messaging is unavailable. */
  }
}

function recheckAttachmentChanges() {
  pageHidden = false
  connectChangeChannel()
  const change = { storageScope: scopedStorageName(BASE_DB_NAME) }
  for (const listener of uploadListeners) listener(change)
}
function visibilityChanged() {
  if (document.visibilityState === 'visible') recheckAttachmentChanges()
}
function hideAttachmentChanges() {
  pageHidden = true
  closeChangeChannel()
}
function watchAttachmentChanges() {
  if (typeof window === 'undefined') return
  if (!watchingChanges) {
    watchingChanges = true
    window.addEventListener('focus', recheckAttachmentChanges)
    window.addEventListener('pageshow', recheckAttachmentChanges)
    window.addEventListener('pagehide', hideAttachmentChanges)
    document.addEventListener('visibilitychange', visibilityChanged)
  }
  connectChangeChannel()
}
function stopWatchingAttachmentChanges() {
  if (uploadListeners.size || releaseListeners.size || !watchingChanges) return
  watchingChanges = false
  closeChangeChannel()
  window.removeEventListener('focus', recheckAttachmentChanges)
  window.removeEventListener('pageshow', recheckAttachmentChanges)
  window.removeEventListener('pagehide', hideAttachmentChanges)
  document.removeEventListener('visibilitychange', visibilityChanged)
}
function publishAttachmentChange(change: AttachmentChange) {
  receiveAttachmentChange(change)
  if (watchingChanges) connectChangeChannel()
  if (typeof BroadcastChannel === 'undefined') return
  let publisher: BroadcastChannel | undefined
  try {
    publisher =
      changeChannel && channelScope === change.storageScope
        ? changeChannel
        : new BroadcastChannel(`attachment-changes:${change.storageScope}`)
    publisher.postMessage(change)
  } catch {
    /* Persisted state remains authoritative; activation can recover a missed message. */
  } finally {
    if (publisher && publisher !== changeChannel) publisher.close()
  }
}

function sourceIds(value: unknown): string[] {
  const ids = new Set<string>()
  const walk = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const item of input) walk(item)
      return
    }
    if (!input || typeof input !== 'object') return
    for (const [key, child] of Object.entries(input)) {
      if ((key === 'dataUrl' || key === 'maskDataUrl') && typeof child === 'string') {
        const id = localAttachmentIdentity(child)
        if (id) ids.add(id)
      } else if (['references', 'submission', 'unsent', 'remainingUnsent'].includes(key))
        walk(child)
    }
  }
  walk(value)
  return [...ids]
}

interface SourceOwner {
  id: string
  sources: string[]
  updatedAt: number
}

/** Capture the account at the document operation's start, including delayed flushes. */
export function attachmentSourceOwner(ownerId: string) {
  const dbName = scopedStorageName(BASE_DB_NAME)
  const change = async (value: unknown, retain: boolean) => {
    const wanted = sourceIds(value)
    if (retain && !wanted.length) return
    await Promise.all(
      wanted.map((id) => pendingSources.get(`aip-local:${id}`)?.reserved.catch(() => {})),
    )
    const db = await openNamedDb(dbName)
    const removed: string[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [STORE_ATTACHMENT_OWNERS, STORE_ATTACHMENT_METADATA, STORE_ATTACHMENT_SOURCES],
          'readwrite',
        )
        const owners = tx.objectStore(STORE_ATTACHMENT_OWNERS)
        const metadata = tx.objectStore(STORE_ATTACHMENT_METADATA)
        const request = owners.get(ownerId)
        request.onsuccess = () => {
          const previous = (request.result as SourceOwner | undefined)?.sources ?? []
          const next = new Set(retain ? [...previous, ...wanted] : wanted)
          for (const id of new Set([...previous, ...next])) {
            const read = metadata.get(id)
            read.onsuccess = () => {
              const row = read.result as SourceMetadata | undefined
              if (!row) {
                // A missing original remains a failed draft position, never a silently removed image.
                return
              }
              const members = new Set(row.owners ?? [])
              if (next.has(id)) members.add(ownerId)
              else members.delete(ownerId)
              if (members.size) metadata.put({ ...row, owners: [...members] })
              else {
                metadata.delete(id)
                tx.objectStore(STORE_ATTACHMENT_SOURCES).delete(id)
                removed.push(`aip-local:${id}`)
              }
            }
          }
          if (next.size)
            owners.put({
              id: ownerId,
              sources: [...next],
              updatedAt: Date.now(),
            } satisfies SourceOwner)
          else owners.delete(ownerId)
        }
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('attachment_owner_failed'))
      })
      if (removed.length)
        publishAttachmentChange({ kind: 'release', sources: removed, storageScope: dbName })
    } finally {
      db.close()
    }
  }
  return {
    withDocument: <T>(work: () => Promise<T>) => withAttachmentDocumentLock(work, dbName),
    retain: (value: unknown) => change(value, true),
    replace: (value: unknown) => change(value, false),
    release: () => change(undefined, false),
  }
}

export function hasLocalAttachmentSources(value: unknown): boolean {
  return sourceIds(value).length > 0
}

const recoveredScopes = new Map<string, Promise<void>>()

/** Scan small document references, never the original-bytes store. A read failure cancels GC. */
async function durableOwners(scopeSuffix: string): Promise<Map<string, string[]>> {
  const owners = new Map<string, string[]>()
  for (const [name, storeName] of [
    ['image-playground-agent-drafts', 'drafts'],
    ['image-playground-agent-outgoing', 'outgoing'],
  ] as const) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(storeName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName)
        const cursor = tx.objectStore(storeName).openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          const key = String(row.key)
          if (scopeSuffix ? key.endsWith(scopeSuffix) : !key.includes(':user-')) {
            if (storeName === 'drafts') owners.set(`draft:${key}`, sourceIds(row.value))
            else if (Array.isArray(row.value)) {
              for (const message of row.value)
                if (typeof message?.id === 'string')
                  owners.set(`outgoing:${key}:${message.id}`, sourceIds(message))
            }
          }
          row.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }
  return owners
}

/** Recover from document truth after restart; active intake is protected by a page lease. */
export function recoverLocalAttachmentSources(): Promise<void> {
  const manager = locks()
  if (!manager) return Promise.resolve() // Older browsers still support explicit owner release.
  const dbName = scopedStorageName(BASE_DB_NAME)
  const previous = recoveredScopes.get(dbName)
  if (previous) return previous
  const scopeSuffix = scopedStorageName('')
  const recovery = withAttachmentDocumentLock(async () => {
    const wanted = await durableOwners(scopeSuffix)
    const db = await openNamedDb(dbName)
    const removed: string[] = []
    try {
      const metadata = await new Promise<SourceMetadata[]>((resolve, reject) => {
        const request = db
          .transaction(STORE_ATTACHMENT_METADATA)
          .objectStore(STORE_ATTACHMENT_METADATA)
          .getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const activeWriters = new Set<string>()
      for (const id of new Set(metadata.flatMap((row) => (row.writerId ? [row.writerId] : [])))) {
        const active = await manager.request(
          `attachment-writer:${dbName}:${id}`,
          { ifAvailable: true },
          (lock) => !lock,
        )
        if (active) activeWriters.add(id)
      }
      const activeSources = new Set(
        metadata
          .filter(
            (row) =>
              (row.writerId && activeWriters.has(row.writerId)) ||
              pendingSources.has(`aip-local:${row.id}`),
          )
          .map((row) => row.id),
      )
      const references = new Map<string, string[]>()
      for (const [owner, sources] of wanted)
        for (const id of sources) references.set(id, [...(references.get(id) ?? []), owner])
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [STORE_ATTACHMENT_METADATA, STORE_ATTACHMENT_OWNERS, STORE_ATTACHMENT_SOURCES],
          'readwrite',
        )
        const sourceStore = tx.objectStore(STORE_ATTACHMENT_SOURCES)
        const metadataStore = tx.objectStore(STORE_ATTACHMENT_METADATA)
        const ownerStore = tx.objectStore(STORE_ATTACHMENT_OWNERS)
        // In-flight document commits use the same lock; reconcile only this account's owner index.
        const oldOwners = ownerStore.openCursor()
        oldOwners.onsuccess = () => {
          const cursor = oldOwners.result
          if (!cursor) return
          const owner = cursor.value as SourceOwner
          if (!wanted.get(owner.id)?.length && !owner.sources.some((id) => activeSources.has(id)))
            cursor.delete()
          cursor.continue()
        }
        for (const [id, sources] of wanted)
          if (sources.length)
            ownerStore.put({ id, sources, updatedAt: Date.now() } satisfies SourceOwner)
        for (const row of metadata) {
          const request = metadataStore.get(row.id)
          request.onsuccess = () => {
            const current = request.result as SourceMetadata | undefined
            if (!current) return
            const members = references.get(row.id) ?? []
            const active = activeSources.has(row.id)
            if (members.length || active)
              metadataStore.put({
                ...current,
                owners: active ? [...new Set([...members, ...(current.owners ?? [])])] : members,
              })
            else {
              metadataStore.delete(row.id)
              sourceStore.delete(row.id)
              removed.push(`aip-local:${row.id}`)
            }
          }
        }
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
    if (removed.length)
      publishAttachmentChange({ kind: 'release', sources: removed, storageScope: dbName })
  }, dbName)
  recoveredScopes.set(dbName, recovery)
  void recovery.catch(() => {
    recoveredScopes.delete(dbName)
  })
  return recovery
}
