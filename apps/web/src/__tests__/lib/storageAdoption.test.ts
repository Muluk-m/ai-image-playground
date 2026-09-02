import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ANONYMOUS_DB = 'image-playground'
const USER_ID = 'u1'
const USER_DB = `${ANONYMOUS_DB}:user-${USER_ID}`
const PERSIST_KEY = 'image-playground'
const SCOPED_PERSIST_KEY = `${PERSIST_KEY}:user-${USER_ID}`

const STORES = ['tasks', 'images', 'thumbnails'] as const
type StoreName = (typeof STORES)[number]
type Seed = Partial<Record<StoreName, Array<Record<string, unknown>>>>

function installLocalStorage(): Map<string, string> {
  const values = new Map<string, string>()
  globalThis.localStorage = {
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
  return values
}

function openRaw(name: string, version = 2): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function seed(name: string, records: Seed, version = 2): Promise<void> {
  const db = await openRaw(name, version)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...STORES], 'readwrite')
    for (const store of STORES) {
      for (const record of records[store] ?? []) tx.objectStore(store).put(record)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function readAll(name: string, store: StoreName): Promise<Array<Record<string, unknown>>> {
  const db = await openRaw(name)
  const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return records
}

async function databaseNames(): Promise<string[]> {
  const databases = await indexedDB.databases()
  return databases.map((database) => database.name ?? '')
}

/** 每个用例重新加载模块：认领本身按启动一次做记忆化，scope 也是模块级状态。 */
async function adopt(userId: string | null): Promise<number> {
  vi.resetModules()
  const { setClientStorageScope } = await import('../../lib/authScope')
  const { adoptAnonymousStorage } = await import('../../lib/storageAdoption')
  setClientStorageScope(userId)
  return adoptAnonymousStorage()
}

let storage: Map<string, string>

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  storage = installLocalStorage()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('adopting anonymous storage after login', () => {
  it('moves every store and the persist key into the user namespace on a first login', async () => {
    await seed(ANONYMOUS_DB, {
      tasks: [{ id: 't1', prompt: 'one' }, { id: 't2' }],
      images: [{ id: 'i1', dataUrl: 'data:,a' }],
      thumbnails: [{ id: 'i1', thumbnailDataUrl: 'data:,b' }],
    })
    storage.set(PERSIST_KEY, '{"settings":"anonymous"}')

    expect(await adopt(USER_ID)).toBe(2)

    expect((await readAll(USER_DB, 'tasks')).map((task) => task.id).sort()).toEqual(['t1', 't2'])
    expect(await readAll(USER_DB, 'images')).toHaveLength(1)
    expect(await readAll(USER_DB, 'thumbnails')).toHaveLength(1)
    expect(storage.get(SCOPED_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
    expect(storage.has(PERSIST_KEY)).toBe(false)
    expect(await databaseNames()).not.toContain(ANONYMOUS_DB)
  })

  it('reports the adopted task count once', async () => {
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] })

    vi.resetModules()
    const { setClientStorageScope } = await import('../../lib/authScope')
    const { adoptAnonymousStorage, takeAdoptedTaskCount } = await import(
      '../../lib/storageAdoption'
    )
    setClientStorageScope(USER_ID)
    await adoptAnonymousStorage()

    expect(takeAdoptedTaskCount()).toBe(3)
    expect(takeAdoptedTaskCount()).toBe(0)
  })

  it('merges into an existing user database without overwriting its records', async () => {
    await seed(ANONYMOUS_DB, {
      tasks: [
        { id: 't1', prompt: 'anonymous' },
        { id: 't2', prompt: 'anonymous' },
      ],
      images: [{ id: 'i1', dataUrl: 'data:,anonymous' }],
    })
    await seed(USER_DB, {
      tasks: [{ id: 't1', prompt: 'already logged in' }],
      images: [{ id: 'i1', dataUrl: 'data:,already logged in' }],
    })

    expect(await adopt(USER_ID)).toBe(1)

    const tasks = await readAll(USER_DB, 'tasks')
    expect(tasks).toHaveLength(2)
    expect(tasks.find((task) => task.id === 't1')?.prompt).toBe('already logged in')
    expect(tasks.find((task) => task.id === 't2')?.prompt).toBe('anonymous')
    expect((await readAll(USER_DB, 'images'))[0]?.dataUrl).toBe('data:,already logged in')
  })

  it('does nothing on a later boot once the anonymous database is gone', async () => {
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }] })
    await adopt(USER_ID)

    expect(await adopt(USER_ID)).toBe(0)
    expect(await readAll(USER_DB, 'tasks')).toHaveLength(1)
    expect(await databaseNames()).not.toContain(ANONYMOUS_DB)
  })

  it('leaves a second account on the same browser with nothing to adopt', async () => {
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }] })
    await adopt(USER_ID)

    expect(await adopt('u2')).toBe(0)
    expect(await readAll(`${ANONYMOUS_DB}:user-u2`, 'tasks')).toHaveLength(0)
  })

  it('keeps the settings of a user who already has a persist key', async () => {
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }] })
    storage.set(PERSIST_KEY, '{"settings":"anonymous"}')
    storage.set(SCOPED_PERSIST_KEY, '{"settings":"mine"}')

    await adopt(USER_ID)

    expect(storage.get(SCOPED_PERSIST_KEY)).toBe('{"settings":"mine"}')
    expect(storage.has(PERSIST_KEY)).toBe(false)
  })

  it('stays out of the way when accounts:login is off', async () => {
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }] })
    storage.set(PERSIST_KEY, '{"settings":"anonymous"}')

    expect(await adopt(null)).toBe(0)

    expect(await readAll(ANONYMOUS_DB, 'tasks')).toHaveLength(1)
    expect(storage.get(PERSIST_KEY)).toBe('{"settings":"anonymous"}')
  })

  it('never creates an empty database when there is nothing to adopt', async () => {
    expect(await adopt(USER_ID)).toBe(0)
    expect(await databaseNames()).not.toContain(ANONYMOUS_DB)
  })

  it('keeps the anonymous data when the copy fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed(ANONYMOUS_DB, { tasks: [{ id: 't1' }] })
    storage.set(PERSIST_KEY, '{"settings":"anonymous"}')
    // 目标库停在更高的版本，认领时的 open 直接抛 VersionError。
    await seed(USER_DB, {}, 5)

    expect(await adopt(USER_ID)).toBe(0)

    expect(await databaseNames()).toContain(ANONYMOUS_DB)
    expect(await readAll(ANONYMOUS_DB, 'tasks')).toHaveLength(1)
    expect(storage.get(PERSIST_KEY)).toBe('{"settings":"anonymous"}')
    expect(logged).toHaveBeenCalled()
  })
})
