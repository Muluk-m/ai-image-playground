import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remixSetStore } from '../../../../features/remix/lib/remixSetStore'
import type { RemixSetRecord } from '../../../../features/remix/types'

const PRODUCT = {
  name: 'W2753 浴缸',
  features: '蛋形单边斜背',
  mainColor: '哑光灰棕',
  forbiddenColors: ['米白'],
}

const SET: RemixSetRecord = {
  id: 'set1',
  name: '奶油浴缸',
  source: {
    kind: 'competitor',
    listingUrl: 'https://www.amazon.com/dp/B0FVLNS696',
    competitorImageIds: ['i1', 'i2'],
  },
  productAssets: [{ assetId: 'a1', angle: 'front' }],
  settings: { platform: 'amazon', language: 'en', level: 'high', product: PRODUCT },
  shots: [],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('remix set storage', () => {
  it('reads back a saved set unchanged', async () => {
    await remixSetStore.put(SET)

    expect(await remixSetStore.list()).toEqual([SET])
  })

  it('replaces a set saved under the same id', async () => {
    await remixSetStore.put(SET)
    await remixSetStore.put({ ...SET, name: '奶油浴缸 v2', updatedAt: 2 })

    const stored = await remixSetStore.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.name).toBe('奶油浴缸 v2')
  })

  it('removes a set', async () => {
    await remixSetStore.put(SET)
    await remixSetStore.remove(SET.id)

    expect(await remixSetStore.list()).toEqual([])
  })
})
