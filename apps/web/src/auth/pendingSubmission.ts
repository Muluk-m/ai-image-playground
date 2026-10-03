import type { AgentDraft } from '../features/agent/lib/references'
import type { PreparedSubmission } from '../store'

/** This tab's one interrupted send. Separate from scoped workspace storage so login adoption cannot move it. */
export type PendingSubmission = (
  | { kind: 'image'; input: PreparedSubmission; template?: true }
  | { kind: 'heroCanvas'; draft: AgentDraft; experience?: 'chat' | 'canvas' }
) & { sourcePath?: string; ownerScope?: string }

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

let loginNavigationId: string | null = null

/** Only the login action may carry this intent through a full-page navigation. */
export function preservePendingSubmissionForLogin(): void {
  loginNavigationId = pendingSubmissionId()
}

export function consumePendingLoginNavigation(id: string): boolean {
  const permitted = loginNavigationId === id && pendingSubmissionId() === id
  if (loginNavigationId === id) loginNavigationId = null
  return permitted
}

const removalListeners = new Set<(id: string) => void>()

function notifyRemoved(id: string): void {
  for (const listener of removalListeners) listener(id)
}

export function subscribePendingSubmissionRemoval(listener: (id: string) => void): () => void {
  removalListeners.add(listener)
  return () => {
    removalListeners.delete(listener)
  }
}

export function pendingSubmissionId(): string | null {
  return sessionStorage.getItem(TAB_KEY)
}

export async function queuePendingSubmission(
  submission: PendingSubmission,
  id: string = crypto.randomUUID(),
): Promise<string> {
  // Publish ownership before awaiting storage so cancellation can invalidate an in-flight write.
  const previous = pendingSubmissionId()
  sessionStorage.setItem(TAB_KEY, id)
  if (previous) notifyRemoved(previous)
  try {
    await access<void>('readwrite', (store) => {
      if (previous && previous !== id) store.delete(previous)
      store.put(submission, id)
    })
    if (pendingSubmissionId() !== id) await discardPendingSubmission(id)
    return id
  } catch (error) {
    if (pendingSubmissionId() === id) sessionStorage.removeItem(TAB_KEY)
    notifyRemoved(id)
    throw error
  }
}

export async function discardPendingSubmission(expectedId?: string): Promise<void> {
  const id = expectedId ?? pendingSubmissionId()
  if (!id) return
  if (pendingSubmissionId() === id) sessionStorage.removeItem(TAB_KEY)
  notifyRemoved(id)
  await access<void>('readwrite', (store) => {
    store.delete(id)
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
  const owned = pendingSubmissionId() === key
  if (owned) sessionStorage.removeItem(TAB_KEY)
  notifyRemoved(key)
  return owned ? pending : undefined
}
