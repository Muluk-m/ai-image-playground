import { scopedStorageName } from '../../../lib/authScope'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

export interface PendingAbortRecovery {
  readonly turnId: string
  /** 尚未取得轮标识时，以原消息 id 恢复撤回或中止；turnId 为本地记录键。 */
  readonly clientMessageId?: string
  readonly draftKey: string
  readonly projectId?: string
}

const DATABASE = 'image-playground-agent-stop-recovery'
const STORE = 'stops'
let database: Promise<IDBDatabase> | undefined
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    void database.catch(() => {
      database = undefined
    })
  }
  return database
}

function storedStops(value: unknown): PendingAbortRecovery[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.some(
      (one) =>
        !one ||
        typeof one !== 'object' ||
        typeof one.turnId !== 'string' ||
        typeof one.draftKey !== 'string' ||
        (one.clientMessageId !== undefined && typeof one.clientMessageId !== 'string') ||
        (one.projectId !== undefined && typeof one.projectId !== 'string'),
    )
  )
    throw new Error('invalid_stop_recovery')
  return value
}

/** Store only the identity of the server's durable return receipt, never message bodies or pixels. */
export function abortRecoveries(conversationId: string) {
  const storageKey = () => scopedStorageName(`agent-stop:${bffBaseUrl()}:${conversationId}`)
  const key = storageKey()
  const current = () => key === storageKey()
  async function read(): Promise<PendingAbortRecovery[]> {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key)
      request.onsuccess = () => {
        try {
          resolve(storedStops(request.result))
        } catch (error) {
          reject(error)
        }
      }
      request.onerror = () => reject(request.error)
    })
  }
  async function change(update: (rows: PendingAbortRecovery[]) => PendingAbortRecovery[]) {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        try {
          const rows = update(storedStops(request.result))
          if (rows.length) store.put(rows, key)
          else store.delete(key)
        } catch {
          tx.abort()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('stop_recovery_write_failed'))
    })
  }
  return {
    current,
    read,
    remember: (pointer: PendingAbortRecovery) =>
      change((rows) =>
        rows.some((one) => one.turnId === pointer.turnId) ? rows : [...rows, pointer],
      ),
    forget: (turnId: string) => change((rows) => rows.filter((one) => one.turnId !== turnId)),
  }
}
