import {
  isSessionRefreshRequestKey,
  type SessionRefreshRequestKey,
} from '@image-playground/shared'

const DATABASE = 'image-playground:session-refresh'
const STORE = 'requests'
interface Journal {
  pending: SessionRefreshRequestKey | null
  completed: SessionRefreshRequestKey | null
}

function parseJournal(value: unknown): Journal {
  if (typeof value !== 'object' || value === null) return { pending: null, completed: null }
  return {
    pending: 'pending' in value && isSessionRefreshRequestKey(value.pending) ? value.pending : null,
    completed: 'completed' in value && isSessionRefreshRequestKey(value.completed) ? value.completed : null,
  }
}

async function change<T>(scope: string, update: (record: Journal) => { record: Journal; result: T }): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return new Promise<T>((resolve, reject) => {
    // Read + write commit before fetch; this also coordinates browsers without Web Locks.
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const read = store.get(scope)
    let result: T
    read.onsuccess = () => {
      try {
        const updated = update(parseJournal(read.result))
        result = updated.result
        store.put(updated.record, scope)
      } catch {
        tx.abort()
      }
    }
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('refresh_journal_unavailable')) }
  })
}

export function acquireRefreshAttempt(scope: string): Promise<{
  requestKey: SessionRefreshRequestKey
  previousKey: SessionRefreshRequestKey | null
}> {
  return change(scope, (record) => {
    const generated = record.pending ?? crypto.randomUUID()
    if (!isSessionRefreshRequestKey(generated)) throw new Error('invalid_refresh_request_key')
    return {
      record: { ...record, pending: generated },
      result: { requestKey: generated, previousKey: record.completed },
    }
  })
}

export function completeRefreshAttempt(scope: string, key: SessionRefreshRequestKey, completedKey = key): Promise<void> {
  return change(scope, (record) => ({
    // An old completion must never erase another tab's newer pending request.
    record: record.pending === key ? { pending: null, completed: completedKey } : record,
    result: undefined,
  }))
}

export function clearRefreshJournal(scope: string): Promise<void> {
  return change(scope, () => ({ record: { pending: null, completed: null }, result: undefined }))
}
