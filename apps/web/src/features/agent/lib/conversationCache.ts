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
let database: Promise<IDBDatabase> | undefined
const clearedScopes = new Set<string>()
const mutations = new Map<string, symbol>()

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2)
      request.onupgradeneeded = () => {
        const db = request.result
        const store = db.objectStoreNames.contains(STORE)
          ? request.transaction!.objectStore(STORE)
          : db.createObjectStore(STORE)
        const metadata = db.createObjectStore(METADATA, { keyPath: 'key' })
        metadata.createIndex('accessedAt', 'accessedAt')
        // Version 1 has at most 50 snapshots; retain them during this one-time migration.
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          try {
            const record = cursor.result.value
            if (record?.version !== 1 || !cachedPanel(record.panel))
              throw new Error('Invalid snapshot')
            metadata.put({
              key: cursor.result.key,
              bytes: recordBytes(record),
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
        request.result.onversionchange = () => {
          request.result.close()
          database = undefined
        }
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
    }).catch((error) => {
      database = undefined
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

function trim(tx: IDBTransaction, key: string, bytes: number, reclaimOnly = false): void {
  const metadata = tx.objectStore(METADATA)
  // Scan small metadata only, never every conversation body on the write/streaming path.
  const request = metadata.index('accessedAt').getAll()
  request.onsuccess = () => {
    const records: CacheMetadata[] = request.result
    const otherBytes = records.reduce(
      (sum, record) => sum + (record.key === key ? 0 : record.bytes),
      0,
    )
    let excess = reclaimOnly
      ? Math.max(bytes, otherBytes * 0.1)
      : otherBytes + bytes - cacheMaxBytes
    for (const record of records) {
      if (excess <= 0) break
      if (record.key === key) continue
      tx.objectStore(STORE).delete(record.key)
      metadata.delete(record.key)
      excess -= record.bytes
    }
  }
}

async function save(db: IDBDatabase, key: string, record: unknown, bytes: number): Promise<void> {
  const tx = db.transaction([STORE, METADATA], 'readwrite')
  const done = complete(tx)
  try {
    trim(tx, key, bytes)
    tx.objectStore(STORE).put(record, key)
    tx.objectStore(METADATA).put({ key, bytes, accessedAt: Date.now() })
  } catch (error) {
    tx.abort()
    await done.catch(() => {})
    throw error
  }
  await done
}

function reclaim(db: IDBDatabase, key: string, bytes: number): Promise<void> {
  const tx = db.transaction([STORE, METADATA], 'readwrite')
  trim(tx, key, bytes, true)
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
        try {
          await save(db, key, record, bytes)
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error
          if (!canWrite()) return
          // The origin also stores artwork. On real disk pressure reclaim only history,
          // commit that reclamation, then retry once; a failed write otherwise rolls it back.
          await reclaim(db, key, bytes)
          if (canWrite()) await save(db, key, record, bytes)
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
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE, METADATA], 'readwrite')
          tx.objectStore(STORE).delete(key)
          tx.objectStore(METADATA).delete(key)
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error)
        })
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
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, METADATA], 'readwrite')
    const cursor = tx.objectStore(STORE).openCursor()
    cursor.onsuccess = () => {
      if (!cursor.result) return
      if (
        typeof cursor.result.key === 'string' &&
        cursor.result.key.startsWith(`[${JSON.stringify(scope)},`)
      ) {
        tx.objectStore(METADATA).delete(cursor.result.key)
        cursor.result.delete()
      }
      cursor.result.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
}
