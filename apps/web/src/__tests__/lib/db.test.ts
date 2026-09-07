import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_DB_NAME, openNamedDb, STORE_ASSETS, STORE_TEMPLATES } from '../../lib/db'

/** updatedAt 之前的库：只有 assets / templates 两张表，记录不带 updatedAt。 */
function seedLegacyDb(records: Record<string, Array<Record<string, unknown>>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BASE_DB_NAME, 7)
    request.onupgradeneeded = () => {
      for (const store of [STORE_ASSETS, STORE_TEMPLATES]) {
        request.result.createObjectStore(store, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction([STORE_ASSETS, STORE_TEMPLATES], 'readwrite')
      for (const [store, rows] of Object.entries(records)) {
        for (const row of rows) tx.objectStore(store).put(row)
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })
}

async function readAll(store: string): Promise<Array<Record<string, unknown>>> {
  const db = await openNamedDb(BASE_DB_NAME)
  const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('upgrading a database written before updatedAt existed', () => {
  it('backfills updatedAt from createdAt on assets and templates', async () => {
    await seedLegacyDb({
      [STORE_ASSETS]: [
        { id: 'a1', name: '白底图', imageId: 'i1', createdAt: 1000, lastUsedAt: 2000 },
      ],
      [STORE_TEMPLATES]: [
        { id: 't1', name: '锁产品前缀', prompt: '换背景', assetIds: [], createdAt: 3000 },
      ],
    })

    expect(await readAll(STORE_ASSETS)).toEqual([
      {
        id: 'a1',
        name: '白底图',
        imageId: 'i1',
        createdAt: 1000,
        updatedAt: 1000,
        lastUsedAt: 2000,
      },
    ])
    expect(await readAll(STORE_TEMPLATES)).toEqual([
      {
        id: 't1',
        name: '锁产品前缀',
        prompt: '换背景',
        assetIds: [],
        createdAt: 3000,
        updatedAt: 3000,
      },
    ])
  })

  it('leaves records that already carry updatedAt alone', async () => {
    await seedLegacyDb({
      [STORE_ASSETS]: [{ id: 'a1', createdAt: 1000, updatedAt: 5000, lastUsedAt: 2000 }],
    })

    expect((await readAll(STORE_ASSETS))[0].updatedAt).toBe(5000)
  })
})
