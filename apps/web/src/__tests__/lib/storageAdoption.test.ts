import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PERSIST_KEY } from '../../lib/authScope'
import { BASE_DB_NAME, DB_STORE_NAMES, type DbStoreName, openNamedDb } from '../../lib/db'

const USER_ID = 'u1'
const USER_DB = `${BASE_DB_NAME}:user-${USER_ID}`
const SCOPED_PERSIST_KEY = `${STORE_PERSIST_KEY}:user-${USER_ID}`
const ADOPTION_DONE_KEY = `${BASE_DB_NAME}:adopted`

type Seed = Partial<Record<DbStoreName, Array<Record<string, unknown>>>>

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

/** 只给「目标库停在更高版本」那一个用例用，其余走 db.ts 的真实 open。 */
function openAtVersion(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      for (const store of DB_STORE_NAMES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'id' })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function seed(name: string, records: Seed, version?: number): Promise<void> {
  const db = version === undefined ? await openNamedDb(name) : await openAtVersion(name, version)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...DB_STORE_NAMES], 'readwrite')
    for (const store of DB_STORE_NAMES) {
      for (const record of records[store] ?? []) tx.objectStore(store).put(record)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function readAll(name: string, store: DbStoreName): Promise<Array<Record<string, unknown>>> {
  const db = await openNamedDb(name)
  const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return records
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((database) => database.name ?? '')
}

/** 每个用例重新加载模块：认领按启动一次做记忆化，scope 也是模块级状态。 */
async function adopt(userId: string | null): Promise<number> {
  vi.resetModules()
  const { setClientStorageScope } = await import('../../lib/authScope')
  const { adoptAnonymousStorage } = await import('../../lib/storageAdoption')
  setClientStorageScope(userId)
  return adoptAnonymousStorage()
}

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', makeLocalStorage(storage))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('adopting anonymous storage after login', () => {
  it('moves every store and the persist key into the user namespace on a first login', async () => {
    await seed(BASE_DB_NAME, {
      tasks: [{ id: 't1', prompt: 'one' }, { id: 't2' }],
      images: [{ id: 'i1', dataUrl: 'data:,a' }],
      thumbnails: [{ id: 'i1', thumbnailDataUrl: 'data:,b' }],
    })
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')

    expect(await adopt(USER_ID)).toBe(2)

    expect((await readAll(USER_DB, 'tasks')).map((task) => task.id).sort()).toEqual(['t1', 't2'])
    expect(await readAll(USER_DB, 'images')).toHaveLength(1)
    expect(await readAll(USER_DB, 'thumbnails')).toHaveLength(1)
    expect(storage.get(SCOPED_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
    expect(storage.has(STORE_PERSIST_KEY)).toBe(false)
    expect(await databaseNames()).not.toContain(BASE_DB_NAME)
  })

  it('merges into an existing user database without overwriting its records', async () => {
    await seed(BASE_DB_NAME, {
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

  it('copies a history larger than one batch', async () => {
    const images = Array.from({ length: 25 }, (_, index) => ({
      id: `i${index}`,
      dataUrl: `data:,${index}`,
    }))
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }], images })

    await adopt(USER_ID)

    expect(await readAll(USER_DB, 'images')).toHaveLength(25)
  })

  it('does nothing on a later boot once the anonymous database is gone', async () => {
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }] })
    await adopt(USER_ID)

    expect(storage.get(ADOPTION_DONE_KEY)).toBe('1')
    expect(await adopt(USER_ID)).toBe(0)

    // 标记之外还有第二道保险：源库已经不在了。
    storage.delete(ADOPTION_DONE_KEY)
    expect(await adopt(USER_ID)).toBe(0)
    expect(await readAll(USER_DB, 'tasks')).toHaveLength(1)
  })

  it('leaves a second account on the same browser with nothing to adopt', async () => {
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }] })
    await adopt(USER_ID)

    expect(await adopt('u2')).toBe(0)
    expect(await readAll(`${BASE_DB_NAME}:user-u2`, 'tasks')).toHaveLength(0)
  })

  it('keeps the settings of a user who already has a persist key', async () => {
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }] })
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')
    storage.set(SCOPED_PERSIST_KEY, '{"settings":"mine"}')

    await adopt(USER_ID)

    expect(storage.get(SCOPED_PERSIST_KEY)).toBe('{"settings":"mine"}')
    expect(storage.has(STORE_PERSIST_KEY)).toBe(false)
  })

  it('stays out of the way when accounts:login is off', async () => {
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }] })
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')

    expect(await adopt(null)).toBe(0)

    expect(await readAll(BASE_DB_NAME, 'tasks')).toHaveLength(1)
    expect(storage.get(STORE_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
  })

  it('never creates an empty database when there is nothing to adopt', async () => {
    expect(await adopt(USER_ID)).toBe(0)
    expect(await databaseNames()).not.toContain(BASE_DB_NAME)
  })

  it('keeps the anonymous data when the copy fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seed(BASE_DB_NAME, { tasks: [{ id: 't1' }] })
    storage.set(STORE_PERSIST_KEY, '{"settings":"anonymous"}')
    // 目标库停在更高的版本，认领时的 open 直接抛 VersionError。
    await seed(USER_DB, {}, 5)

    expect(await adopt(USER_ID)).toBe(0)

    expect(await databaseNames()).toContain(BASE_DB_NAME)
    expect(await readAll(BASE_DB_NAME, 'tasks')).toHaveLength(1)
    expect(storage.get(STORE_PERSIST_KEY)).toBe('{"settings":"anonymous"}')
    expect(storage.has(ADOPTION_DONE_KEY)).toBe(false)
    expect(logged).toHaveBeenCalled()
  })
})
