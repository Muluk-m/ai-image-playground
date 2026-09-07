import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PERSIST_KEY, SYNC_CHECKPOINT_KEY, setClientStorageScope } from '../../lib/authScope'
import { clearScopedClientStorage } from '../../lib/clearScopedStorage'
import { BASE_DB_NAME, DB_STORE_NAMES, type DbStoreName, openNamedDb } from '../../lib/db'

const USER_ID = 'u1'
const USER_DB = `${BASE_DB_NAME}:user-${USER_ID}`

function makeLocalStorage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

async function seed(name: string): Promise<void> {
  const db = await openNamedDb(name)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...DB_STORE_NAMES], 'readwrite')
    for (const storeName of DB_STORE_NAMES) tx.objectStore(storeName).put({ id: `${name}-row` })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function readAll(name: string, storeName: DbStoreName): Promise<unknown[]> {
  const db = await openNamedDb(name)
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', makeLocalStorage(storage))
})

afterEach(() => {
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

describe('clearing the local data of the scope being logged out of', () => {
  it('empties every store and key of that scope', async () => {
    await seed(USER_DB)
    storage.set(`${STORE_PERSIST_KEY}:user-${USER_ID}`, '{"settings":"mine"}')
    storage.set(`${SYNC_CHECKPOINT_KEY}:user-${USER_ID}`, '{"version":7}')
    setClientStorageScope(USER_ID)

    await clearScopedClientStorage()

    for (const storeName of DB_STORE_NAMES) {
      expect(await readAll(USER_DB, storeName)).toEqual([])
    }
    expect(storage.size).toBe(0)
  })

  it('leaves the anonymous scope untouched', async () => {
    await seed(BASE_DB_NAME)
    await seed(USER_DB)
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')
    setClientStorageScope(USER_ID)

    await clearScopedClientStorage()

    expect(await readAll(BASE_DB_NAME, 'tasks')).toHaveLength(1)
    expect(storage.get(STORE_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
  })

  it('does nothing at all while the scope is anonymous', async () => {
    await seed(BASE_DB_NAME)
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')
    setClientStorageScope(null)

    await clearScopedClientStorage()

    expect(await readAll(BASE_DB_NAME, 'tasks')).toHaveLength(1)
    expect(storage.get(STORE_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
  })
})
