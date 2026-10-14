import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendGeneratedAssetView, assetStore } from '../../../../features/library/lib/assetStore'
import { type AssetRecord, assetCoverImageId } from '../../../../features/library/types'
import { dbTransaction, STORE_ASSETS } from '../../../../lib/db'

function makeAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'a1',
    name: '产品白底图',
    views: [{ imageId: 'image-1', label: 'none', source: 'upload' }],
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
    expect(new Set(assets.map((asset) => assetCoverImageId(asset)))).toEqual(new Set(['image-1']))
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

it('appends generated views atomically while preserving current metadata and deduplicating retries', async () => {
  await assetStore.put(makeAsset({ description: 'latest description', voiceId: 'voice' }))
  const a = { imageId: 'a', label: 'sheet' as const, source: 'generated' as const }
  const b = { ...a, imageId: 'b' }
  await Promise.all([appendGeneratedAssetView('a1', a), appendGeneratedAssetView('a1', b)])
  await appendGeneratedAssetView('a1', b)
  const saved = (await assetStore.list())[0]!
  expect(saved.views.map((view) => view.imageId)).toEqual(['b', 'a', 'image-1'])
  expect(saved).toMatchObject({
    description: 'latest description',
    voiceId: 'voice',
    name: '产品白底图',
  })
})
it('never resurrects deleted assets and aborts a result that became stale before the transaction', async () => {
  await assetStore.put(makeAsset())
  const view = { imageId: 'derived', label: 'none' as const, source: 'generated' as const }
  expect(await appendGeneratedAssetView('a1', view, () => false)).toBeNull()
  expect((await assetStore.list())[0]!.views).toHaveLength(1)
  await assetStore.remove('a1')
  expect(await appendGeneratedAssetView('a1', view)).toBeNull()
  expect(await assetStore.list()).toEqual([])
})

it('preserves an existing view label and source when adopting the same pixels again', async () => {
  await assetStore.put(
    makeAsset({ views: [{ imageId: 'original', label: 'front', source: 'upload' }] }),
  )
  await appendGeneratedAssetView('a1', { imageId: 'original', label: 'sheet', source: 'generated' })
  expect((await assetStore.list())[0]!.views).toEqual([
    { imageId: 'original', label: 'front', source: 'upload' },
  ])
})
