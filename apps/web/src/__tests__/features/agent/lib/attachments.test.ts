import { AGENT_TURN_MAX_INLINE_REFERENCES } from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAssetToDraft } from '../../../../features/agent/lib/attachments'
import type { AgentDraft } from '../../../../features/agent/lib/references'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import type { AssetRecord } from '../../../../features/library/types'
import { getMentionedImageIndexes } from '../../../../lib/promptImageMentions'
import type { InputImage } from '../../../../types'

const PIXEL = 'data:image/png;base64,aGk='

let assets: AssetRecord[] = []
/** 素材的哪几张视角真取得回来——取不回来的那几张由 `assetViewImages` 自己丢掉。 */
let loadedViews: InputImage[] = []
const used: string[] = []
const toasts: string[] = []

vi.mock('../../../../store', () => ({
  useStore: { getState: () => ({ showToast: (message: string) => toasts.push(message) }) },
}))

vi.mock('../../../../features/library/store', () => ({
  assetViewImages: async () => loadedViews,
  useLibraryStore: {
    getState: () => ({
      assets,
      noteAssetUsed: async (id: string) => {
        used.push(id)
      },
    }),
  },
}))

function asset(views: AssetRecord['views']): AssetRecord {
  return { id: 'asset-1', name: '橘猫产品图', views, createdAt: 0, updatedAt: 0, lastUsedAt: 0 }
}

function filled(count: number): AgentDraft {
  return {
    prompt: '',
    references: Array.from({ length: count }, (_, index) => ({
      id: `taken-${index}`,
      dataUrl: PIXEL,
    })),
  }
}

beforeEach(() => {
  used.length = 0
  toasts.length = 0
  assets = [asset([{ imageId: 'img-cat', label: 'none', source: 'upload' }])]
  loadedViews = [{ id: 'img-cat', dataUrl: PIXEL }]
})

describe('素材变成参考图', () => {
  it('引用按素材名认领，并记一笔使用', async () => {
    const attached = await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)

    expect(attached?.draft.references).toEqual([
      { id: 'img-cat', dataUrl: PIXEL, name: '橘猫产品图' },
    ])
    expect(used).toEqual(['asset-1'])
  })

  it('组里全部视角按序进参考图条，提示词里只占一个胶囊', async () => {
    loadedViews = [
      { id: 'img-front', dataUrl: PIXEL },
      { id: 'img-side', dataUrl: PIXEL },
    ]

    const attached = await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)

    expect(attached?.draft.references.map((one) => one.id)).toEqual(['img-front', 'img-side'])
    // 一条素材一个胶囊，指向封面那一位。
    expect(getMentionedImageIndexes(attached?.draft.prompt ?? '')).toEqual([0])
  })

  it('素材不在库里就什么都不做', async () => {
    expect(await attachAssetToDraft(EMPTY_DRAFT, 'asset-missing', 0, 0)).toBeNull()
    expect(used).toEqual([])
  })

  it('图一张都取不回来就没有这条引用，也不记使用', async () => {
    loadedViews = []

    expect(await attachAssetToDraft(EMPTY_DRAFT, 'asset-1', 0, 0)).toBeNull()
    expect(used).toEqual([])
  })

  it('整组视角放不下就一张都不附，胶囊也不插', async () => {
    loadedViews = [
      { id: 'img-front', dataUrl: PIXEL },
      { id: 'img-side', dataUrl: PIXEL },
    ]
    // 素材只能内联字节，撞的是内联那道上限。
    const draft = filled(AGENT_TURN_MAX_INLINE_REFERENCES - 1)

    const attached = await attachAssetToDraft(draft, 'asset-1', 0, 0)

    expect(attached?.refusal).toBe('inlineOverflow')
    expect(attached?.draft).toBe(draft)
  })
})
