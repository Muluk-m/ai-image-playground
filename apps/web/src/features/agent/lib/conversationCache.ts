import { accountScope, scopedStorageName } from '../../../lib/authScope'
import { getRuntimeConfig } from '../../../lib/runtimeConfig'
import type { AgentToolMessage } from '../types'
import { cachedPanel } from './conversationCachePanel'
import { cacheMaxBytes } from './conversationCachePolicy'
import type { AgentPanelState } from './panelMessages'
import { turnCostWithJobs } from './turnCost'

const DATABASE = 'image-playground-agent-history'
const STORE = 'conversations'
const METADATA = 'metadata'
const USAGE = 'usage'
const STORES = [STORE, METADATA, USAGE]
let database: Promise<IDBDatabase> | undefined
const clearedScopes = new Set<string>()
const mutations = new Map<string, symbol>()

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    let abandoned = false
    database = new Promise<IDBDatabase>((resolve, reject) => {
      // v3 fences out v2 tabs, whose writes do not participate in revision checks.
      const request = indexedDB.open(DATABASE, 3)
      const abandon = () => {
        abandoned = true
        clearTimeout(timeout)
        reject(new Error('Conversation cache open unavailable'))
      }
      const timeout = setTimeout(abandon, 5000)
      request.onblocked = abandon
      request.onupgradeneeded = (event) => {
        if (event.oldVersion >= 2) return
        const db = request.result
        const store = db.objectStoreNames.contains(STORE)
          ? request.transaction!.objectStore(STORE)
          : db.createObjectStore(STORE)
        const metadata = db.createObjectStore(METADATA, { keyPath: 'key' })
        metadata.createIndex('accessedAt', 'accessedAt')
        db.createObjectStore(USAGE)
        let totalBytes = 0
        // Version 1 has at most 50 snapshots; retain them during this one-time migration.
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) {
            trim(request.transaction!, totalBytes, cacheMaxBytes)
            return
          }
          try {
            const record = cursor.result.value
            if (record?.version !== 1 || !cachedPanel(record.panel))
              throw new Error('Invalid snapshot')
            const bytes = recordBytes(record)
            totalBytes += bytes
            metadata.put({
              key: cursor.result.key,
              bytes,
              accessedAt:
                typeof record.savedAt === 'number' && Number.isFinite(record.savedAt)
                  ? record.savedAt
                  : 0,
            })
          } catch {
            cursor.result.delete()
          }
          cursor.result.continue()
        }
      }
      request.onsuccess = () => {
        clearTimeout(timeout)
        if (abandoned) {
          request.result.close()
          database = undefined
          return
        }
        request.result.onversionchange = () => {
          request.result.close()
          database = undefined
        }
        resolve(request.result)
      }
      request.onerror = () => {
        clearTimeout(timeout)
        database = undefined
        reject(request.error)
      }
    }).catch((error) => {
      // Keep a rejected result while its un-cancellable request is queued behind old tabs.
      // Reopening on every call could leave subsequent requests waiting without onblocked.
      if (!abandoned) database = undefined
      throw error
    })
  }
  return database
}

type CacheMetadata = { key: string; bytes: number; accessedAt: number }

function recordBytes(record: unknown): number {
  // UTF-8 payload size is deterministic; IndexedDB's implementation overhead varies.
  return new TextEncoder().encode(JSON.stringify(record)).byteLength
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
}

async function touch(db: IDBDatabase, key: string, isCurrent: () => boolean): Promise<void> {
  try {
    if (!isCurrent()) return
    const tx = db.transaction(METADATA, 'readwrite')
    const store = tx.objectStore(METADATA)
    const request = store.get(key)
    request.onsuccess = () => {
      if (request.result && isCurrent()) store.put({ ...request.result, accessedAt: Date.now() })
    }
    await complete(tx)
  } catch {
    // Reading cached content still succeeds when recency cannot be persisted.
  }
}

function trim(tx: IDBTransaction, totalBytes: number, budget: number, keep?: string): void {
  const usage = tx.objectStore(USAGE)
  if (totalBytes <= budget) {
    usage.put(totalBytes, 'bytes')
    return
  }
  // Walk only the oldest metadata needed for eviction, never clone the full cache index.
  const metadata = tx.objectStore(METADATA)
  const request = metadata.index('accessedAt').openCursor()
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor || totalBytes <= budget) {
      usage.put(totalBytes, 'bytes')
      return
    }
    const record: CacheMetadata = cursor.value
    if (record.key !== keep) {
      tx.objectStore(STORE).delete(record.key)
      cursor.delete()
      totalBytes -= record.bytes
    }
    cursor.continue()
  }
}

type CacheWrite = { key: string; record: unknown; bytes: number; revision?: string | null }

async function save(db: IDBDatabase, write: CacheWrite, retry = false): Promise<void> {
  const { key, record, bytes } = write
  const tx = db.transaction(STORES, 'readwrite')
  const done = complete(tx)
  const usage = tx.objectStore(USAGE)
  const revision = usage.get('revision')
  let writeError: unknown
  revision.onsuccess = () => {
    if (retry && (write.revision === undefined || (revision.result ?? null) !== write.revision))
      return
    write.revision = revision.result ?? null
    try {
      const metadata = tx.objectStore(METADATA)
      const previous = metadata.get(key)
      previous.onsuccess = () => {
        const total = usage.get('bytes')
        total.onsuccess = () => {
          trim(tx, (total.result ?? 0) - (previous.result?.bytes ?? 0) + bytes, cacheMaxBytes, key)
        }
      }
      tx.objectStore(STORE).put(record, key)
      metadata.put({ key, bytes, accessedAt: Date.now() })
      usage.put(crypto.randomUUID(), 'revision')
    } catch (error) {
      writeError = error
      tx.abort()
    }
  }
  try {
    await done
  } catch (error) {
    throw writeError ?? error
  }
}

async function reclaim(db: IDBDatabase, write: CacheWrite): Promise<boolean> {
  const tx = db.transaction(STORES, 'readwrite')
  const usage = tx.objectStore(USAGE)
  const revision = usage.get('revision')
  let canRetry = false
  revision.onsuccess = () => {
    if (write.revision === undefined || (revision.result ?? null) !== write.revision) return
    canRetry = true
    const request = usage.get('bytes')
    request.onsuccess = () => {
      const total = request.result ?? 0
      trim(tx, total, Math.max(0, total - Math.max(write.bytes, total * 0.1)), write.key)
    }
  }
  await complete(tx)
  return canRetry
}

function remove(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(STORES, 'readwrite')
  tx.objectStore(USAGE).put(crypto.randomUUID(), 'revision')
  const metadata = tx.objectStore(METADATA)
  const record = metadata.get(key)
  record.onsuccess = () => {
    const usage = tx.objectStore(USAGE)
    const total = usage.get('bytes')
    total.onsuccess = () => usage.put((total.result ?? 0) - (record.result?.bytes ?? 0), 'bytes')
  }
  tx.objectStore(STORE).delete(key)
  metadata.delete(key)
  return complete(tx)
}

/** Display-only snapshots: never restore executors, queues or artifact delivery from this cache. */
export function conversationCache(conversationId: string) {
  const backend = getRuntimeConfig().bff.baseUrl
  const sameAccount = accountScope()
  const scope = scopedStorageName(DATABASE)
  const key = JSON.stringify([scope, backend, conversationId])
  const isCurrent = () =>
    !clearedScopes.has(scope) && sameAccount() && getRuntimeConfig().bff.baseUrl === backend
  return {
    conversationId,
    isCurrent,
    async read(): Promise<AgentPanelState | null> {
      try {
        const db = await openDatabase()
        const record = await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction(STORE).objectStore(STORE).get(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        if (
          !isCurrent() ||
          !record ||
          typeof record !== 'object' ||
          !('version' in record) ||
          record.version !== 1 ||
          !('panel' in record)
        )
          return null
        const panel = cachedPanel(record.panel)
        if (panel) {
          // Do not hold first paint behind a metadata write (including disk quota failures).
          void touch(db, key, isCurrent)
        }
        return panel
      } catch {
        return null
      }
    },
    async write(panel: AgentPanelState): Promise<void> {
      const mutation = Symbol()
      mutations.set(key, mutation)
      const canWrite = () => isCurrent() && mutations.get(key) === mutation
      try {
        const turns = Object.fromEntries(
          Object.entries(panel.turns).map(([id, footer]) => [
            id,
            {
              ...footer,
              ...(footer.cost
                ? {
                    cost: turnCostWithJobs(
                      footer.cost,
                      panel.messages.filter(
                        (message): message is AgentToolMessage =>
                          message.kind === 'tool' && message.turnId === footer.turnId,
                      ),
                    ),
                  }
                : {}),
            },
          ]),
        )
        const db = await openDatabase()
        if (!canWrite()) return
        const record = {
          version: 1,
          savedAt: Date.now(),
          panel: { messages: panel.messages, turns },
        }
        const bytes = recordBytes(record)
        if (bytes > cacheMaxBytes) return
        const write: CacheWrite = { key, record, bytes }
        try {
          await save(db, write)
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error
          if (!canWrite()) return
          // The origin also stores artwork. On real disk pressure reclaim only history,
          // commit that reclamation, then retry once; a failed write otherwise rolls it back.
          if (!(await reclaim(db, write))) return
          // A single durable revision also covers deletes of absent keys and scope clears,
          // without retaining per-conversation tombstones. Unrelated writes may cancel a retry.
          if (canWrite()) await save(db, write, true)
        }
      } catch {
        // A full, blocked or unavailable cache must never prevent reading the server.
      } finally {
        if (mutations.get(key) === mutation) mutations.delete(key)
      }
    },
    async remove(): Promise<void> {
      mutations.delete(key)
      try {
        const db = await openDatabase()
        await remove(db, key)
      } catch {
        // The server remains authoritative if local storage is unavailable.
      }
    },
  }
}

/** Logout's explicit local-data removal includes all API backends for this account. */
export async function clearConversationCache(): Promise<void> {
  const scope = scopedStorageName(DATABASE)
  if (scope === DATABASE) return
  clearedScopes.add(scope)
  const db = await openDatabase()
  const tx = db.transaction(STORES, 'readwrite')
  tx.objectStore(USAGE).put(crypto.randomUUID(), 'revision')
  let removedBytes = 0
  const cursor = tx.objectStore(METADATA).openCursor()
  cursor.onsuccess = () => {
    if (!cursor.result) {
      const usage = tx.objectStore(USAGE)
      const total = usage.get('bytes')
      total.onsuccess = () => usage.put((total.result ?? 0) - removedBytes, 'bytes')
      return
    }
    const record: CacheMetadata = cursor.result.value
    if (record.key.startsWith(`[${JSON.stringify(scope)},`)) {
      tx.objectStore(STORE).delete(record.key)
      removedBytes += record.bytes
      cursor.result.delete()
    }
    cursor.result.continue()
  }
  await complete(tx)
}
