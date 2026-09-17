import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assetToReference } from '../../../../features/agent/lib/attachments'

const PIXEL = 'data:image/png;base64,aGk='

/** 调用顺序是这条路的全部：先把图取回本机，再读缓存，最后才记一笔使用。 */
const calls: string[] = []
let assets: { id: string; imageId: string; name: string }[] = []
let cached: string | undefined = PIXEL
let synced = true

vi.mock('../../../../lib/sync/assetImages', () => ({
  ensureAssetImage: vi.fn(async () => {
    calls.push('ensureAssetImage')
    return synced
  }),
}))

vi.mock('../../../../store', () => ({
  ensureImageCached: vi.fn(async () => {
    calls.push('ensureImageCached')
    return cached
  }),
  useStore: { getState: () => ({ showToast: vi.fn() }) },
}))

vi.mock('../../../../features/library/store', () => ({
  useLibraryStore: {
    getState: () => ({
      assets,
      noteAssetUsed: async () => {
        calls.push('noteAssetUsed')
      },
    }),
  },
}))

beforeEach(() => {
  calls.length = 0
  assets = [{ id: 'asset-1', imageId: 'img-cat', name: '橘猫产品图' }]
  cached = PIXEL
  synced = true
})

describe('素材变成参考图', () => {
  it('取回图、读缓存、记一笔使用，引用按素材名认领', async () => {
    const reference = await assetToReference('asset-1')

    expect(reference).toEqual({ id: 'img-cat', dataUrl: PIXEL, name: '橘猫产品图' })
    expect(calls).toEqual(['ensureAssetImage', 'ensureImageCached', 'noteAssetUsed'])
  })

  it('素材不在库里就没有这条引用，图也不去取', async () => {
    expect(await assetToReference('asset-missing')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('图取不回来就没有这条引用，也不记使用', async () => {
    cached = undefined
    synced = false

    expect(await assetToReference('asset-1')).toBeUndefined()
    expect(calls).toEqual(['ensureAssetImage', 'ensureImageCached'])
  })
})
