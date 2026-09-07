import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetStore } from '../../../../features/library/lib/assetStore'
import type { AssetRecord } from '../../../../features/library/types'
import { dbTransaction, STORE_ASSETS } from '../../../../lib/db'

function makeAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'a1',
    name: '产品白底图',
    imageId: 'image-1',
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('asset storage', () => {
  it('reads back what it wrote', async () => {
    await assetStore.put(makeAsset())

    expect(await assetStore.list()).toEqual([makeAsset()])
  })

  it('keeps several names for the same image', async () => {
    await assetStore.put(makeAsset({ id: 'a1', name: '白底图' }))
    await assetStore.put(makeAsset({ id: 'a2', name: '主图' }))

    const assets = await assetStore.list()
    expect(assets.map((asset) => asset.name).sort()).toEqual(['主图', '白底图'])
    expect(new Set(assets.map((asset) => asset.imageId))).toEqual(new Set(['image-1']))
  })

  it('replaces a record on the same id', async () => {
    await assetStore.put(makeAsset())
    await assetStore.put(makeAsset({ name: '改过的名字' }))

    const assets = await assetStore.list()
    expect(assets).toHaveLength(1)
    expect(assets[0].name).toBe('改过的名字')
  })

  it('removes one record', async () => {
    await assetStore.put(makeAsset({ id: 'a1' }))
    await assetStore.put(makeAsset({ id: 'a2' }))

    await assetStore.remove('a1')

    expect((await assetStore.list()).map((asset) => asset.id)).toEqual(['a2'])
  })

  it('leaves a tombstone behind instead of dropping the row', async () => {
    await assetStore.put(makeAsset({ id: 'a1' }))

    await assetStore.remove('a1')

    const rows = await dbTransaction<Array<Record<string, unknown>>>(
      STORE_ASSETS,
      'readonly',
      (store) => store.getAll(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('a1')
    expect(typeof rows[0].deletedAt).toBe('number')
    expect(rows[0].name).toBeUndefined()
  })

  it('hides a tombstone written by another device', async () => {
    await dbTransaction(STORE_ASSETS, 'readwrite', (store) =>
      store.put({ id: 'a1', updatedAt: 2000, deletedAt: 2000 }),
    )

    expect(await assetStore.list()).toEqual([])
  })
})
