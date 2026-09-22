import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAssetToDraft } from '../../../../features/agent/lib/attachments'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import type { AssetRecord } from '../../../../features/library/types'
import { getMentionedImageIndexes } from '../../../../lib/promptImageMentions'

const PIXEL = 'data:image/png;base64,aGk='

/** 调用顺序是这条路的全部：先把图取回本机，再读缓存，最后才记一笔使用。 */
const calls: string[] = []
let assets: AssetRecord[] = []
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

function asset(views: AssetRecord['views']): AssetRecord {
  return { id: 'asset-1', name: '橘猫产品图', views, createdAt: 0, updatedAt: 0, lastUsedAt: 0 }
}

beforeEach(() => {
  calls.length = 0
  assets = [asset([{ imageId: 'img-cat', label: 'none', source: 'upload' }])]
  cached = PIXEL
  synced = true
})

describe('素材变成参考图', () => {
  it('取回图、读缓存、记一笔使用，引用按素材名认领', async () => {
    const attached = await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)

    expect(attached?.draft.references).toEqual([
      { id: 'img-cat', dataUrl: PIXEL, name: '橘猫产品图' },
    ])
    expect(calls).toEqual(['ensureAssetImage', 'ensureImageCached', 'noteAssetUsed'])
  })

  it('组里全部视角按序进参考图条，提示词里只占一个胶囊', async () => {
    assets = [
      asset([
        { imageId: 'img-front', label: 'front', source: 'upload' },
        { imageId: 'img-side', label: 'side', source: 'generated' },
      ]),
    ]

    const attached = await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)

    expect(attached?.draft.references.map((one) => one.id)).toEqual(['img-front', 'img-side'])
    // 一条素材一个胶囊，指向封面那一位。
    expect(getMentionedImageIndexes(attached?.draft.prompt ?? '')).toEqual([0])
  })

  it('素材不在库里就什么都不做，图也不去取', async () => {
    expect(await attachAssetToDraft(EMPTY_DRAFT, 'asset-missing', 0, 0)).toBeNull()
    expect(calls).toEqual([])
  })

  it('图一张都取不回来就没有这条引用，也不记使用', async () => {
    cached = undefined
    synced = false

    expect(await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)).toBeNull()
    expect(calls).toEqual(['ensureAssetImage', 'ensureImageCached'])
  })
})
