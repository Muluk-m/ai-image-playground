import type { AgentDraft } from '../features/agent/lib/references'
import type { PreparedSubmission } from '../store'

/** This tab's one interrupted send. Separate from scoped workspace storage so login adoption cannot move it. */
export type PendingSubmission =
  | { kind: 'image'; input: PreparedSubmission }
  | { kind: 'heroCanvas'; draft: AgentDraft }

const DATABASE = 'image-playground:pending-send'
const STORE = 'submission'
const TAB_KEY = 'image-playground:pending-send-id'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function access<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void) => void,
): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    let result: T
    run(tx.objectStore(STORE), (value) => {
      result = value
    })
    tx.oncomplete = () => {
      db.close()
      resolve(result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error)
    }
  })
}

export async function queuePendingSubmission(submission: PendingSubmission): Promise<void> {
  const key = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID()
  await access<void>('readwrite', (store) => {
    store.put(submission, key)
  })
  sessionStorage.setItem(TAB_KEY, key)
}

export async function discardPendingSubmission(): Promise<void> {
  const key = sessionStorage.getItem(TAB_KEY)
  if (!key) return
  sessionStorage.removeItem(TAB_KEY)
  await access<void>('readwrite', (store) => {
    store.delete(key)
  })
}

export function hasPendingSubmission(): Promise<boolean> {
  const key = sessionStorage.getItem(TAB_KEY)
  if (!key) return Promise.resolve(false)
  return access('readonly', (store, setResult) => {
    const request = store.getKey(key)
    request.onsuccess = () => setResult(request.result !== undefined)
  })
}

/** Delete and read in one transaction: StrictMode and concurrent mounts cannot send twice. */
export async function takePendingSubmission(): Promise<PendingSubmission | undefined> {
  const key = sessionStorage.getItem(TAB_KEY)
  if (!key) return undefined
  const pending = await access<PendingSubmission | undefined>('readwrite', (store, setResult) => {
    const request = store.get(key)
    request.onsuccess = () => {
      setResult(request.result as PendingSubmission | undefined)
      store.delete(key)
    }
  })
  sessionStorage.removeItem(TAB_KEY)
  return pending
}
