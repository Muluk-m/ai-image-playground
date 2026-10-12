import { accountScope, scopedStorageName } from '../../../lib/authScope'
import { getRuntimeConfig } from '../../../lib/runtimeConfig'
import type { AgentToolMessage } from '../types'
import { cachedPanel } from './conversationCachePanel'
import type { AgentPanelState } from './panelMessages'
import { turnCostWithJobs } from './turnCost'

const DATABASE = 'image-playground-agent-history'
const STORE = 'conversations'
const LIMIT = 50
let database: Promise<IDBDatabase> | undefined
const clearedScopes = new Set<string>()

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE).createIndex('savedAt', 'savedAt')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch((error) => {
      database = undefined
      throw error
    })
  }
  return database
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
        return cachedPanel(record.panel)
      } catch {
        return null
      }
    },
    async write(panel: AgentPanelState): Promise<void> {
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
        if (!isCurrent()) return
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          const store = tx.objectStore(STORE)
          store.put(
            { version: 1, savedAt: Date.now(), panel: { messages: panel.messages, turns } },
            key,
          )
          const count = store.count()
          count.onsuccess = () => {
            let excess = count.result - LIMIT
            if (excess <= 0) return
            const cursor = store.index('savedAt').openCursor()
            cursor.onsuccess = () => {
              if (!cursor.result || excess-- <= 0) return
              cursor.result.delete()
              cursor.result.continue()
            }
          }
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error)
          tx.onerror = () => reject(tx.error)
        })
      } catch {
        // A full, blocked or unavailable cache must never prevent reading the server.
      }
    },
    async remove(): Promise<void> {
      try {
        const db = await openDatabase()
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).delete(key)
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error)
          tx.onerror = () => reject(tx.error)
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
    const tx = db.transaction(STORE, 'readwrite')
    const cursor = tx.objectStore(STORE).openCursor()
    cursor.onsuccess = () => {
      if (!cursor.result) return
      if (
        typeof cursor.result.key === 'string' &&
        cursor.result.key.startsWith(`[${JSON.stringify(scope)},`)
      )
        cursor.result.delete()
      cursor.result.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}
