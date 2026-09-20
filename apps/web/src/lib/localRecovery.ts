import { STORE_PERSIST_KEY, safeLocalStorage } from './authScope'

const LAST_USER_KEY = 'image-playground.last-storage-user'

/** This remembers a local namespace only, never a server credential or authenticated identity. */
export function rememberStorageUser(id: string | null): void {
  safeLocalStorage.setItem(LAST_USER_KEY, JSON.stringify(id))
}

export async function recoverStorageUser(): Promise<string | null> {
  const remembered = safeLocalStorage.getItem(LAST_USER_KEY)
  if (remembered !== null) {
    try {
      const id: unknown = JSON.parse(remembered)
      if (id === null || (typeof id === 'string' && id.length > 0)) return id
    } catch {
      // Older installations have no usable marker; discover only an unambiguous namespace.
    }
  }
  const ids = new Set<string>()
  const prefix = `${STORE_PERSIST_KEY}:user-`
  const collect = (name: string) => {
    if (!name.startsWith(prefix)) return
    try {
      const id = decodeURIComponent(name.slice(prefix.length))
      if (id) ids.add(id)
    } catch {
      // Ignore malformed storage names.
    }
  }
  try {
    for (let index = 0; index < localStorage.length; index++) collect(localStorage.key(index) ?? '')
  } catch {
    // IndexedDB can still be readable when localStorage is disabled.
  }
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    for (const database of await indexedDB.databases()) collect(database.name ?? '')
  }
  // Never guess between two accounts or merge their data during failover.
  if (ids.size > 1) throw new Error('Multiple local accounts require explicit selection')
  const id = [...ids][0] ?? null
  rememberStorageUser(id)
  return id
}
