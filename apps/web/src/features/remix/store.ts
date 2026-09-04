import { create } from 'zustand'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { storeImageFromFile, storeImageFromUrl, useStore } from '../../store'
import { fetchListingImages, listingImageProxyUrl } from './lib/listingClient'
import { remixSetStore } from './lib/remixSetStore'
import type {
  ProductAngle,
  RemixProductAsset,
  RemixSetRecord,
  RemixSetSettings,
  RemixShot,
} from './types'

export type RemixStep = 1 | 2 | 3

const UPLOAD_FALLBACK = '请直接上传竞品图'
const DEFAULT_PRODUCT_ANGLE: ProductAngle = 'three-quarter'
const DEFAULT_SETTINGS: RemixSetSettings = { platform: 'amazon', language: 'zh', level: 'high' }

export interface RemixDraft {
  /** 已保存的套 id；null 表示还没落盘。 */
  id: string | null
  name: string
  listingUrl: string
  competitorImageIds: string[]
  productAssets: RemixProductAsset[]
  settings: RemixSetSettings
  shots: RemixShot[]
  createdAt: number | null
}

export interface RemixState {
  sets: RemixSetRecord[]
  activeSetId: string | null
  step: RemixStep
  draft: RemixDraft
  listingLoading: boolean
  /** 抓图不可用时给出的回落说明，null 表示没有可说的。 */
  listingNotice: string | null

  loadSets: () => Promise<void>
  startNewSet: () => void
  selectSet: (id: string) => void
  setStep: (step: RemixStep) => void

  setName: (name: string) => void
  setListingUrl: (url: string) => void
  fetchListing: () => Promise<void>
  importCompetitorFiles: (files: File[]) => Promise<void>
  addCompetitorImages: (imageIds: string[]) => void
  removeCompetitorImage: (imageId: string) => void

  toggleProductAsset: (assetId: string) => void
  setProductAngle: (assetId: string, angle: ProductAngle) => void
  updateSettings: (patch: Partial<RemixSetSettings>) => void

  saveAndContinue: () => Promise<void>
}

function emptyDraft(): RemixDraft {
  return {
    id: null,
    name: '',
    listingUrl: '',
    competitorImageIds: [],
    productAssets: [],
    settings: { ...DEFAULT_SETTINGS },
    shots: [],
    createdAt: null,
  }
}

function draftFromSet(set: RemixSetRecord): RemixDraft {
  return {
    id: set.id,
    name: set.name,
    listingUrl: set.source.listingUrl ?? '',
    competitorImageIds: [...set.source.competitorImageIds],
    productAssets: set.productAssets.map((product) => ({ ...product })),
    settings: { ...set.settings },
    shots: set.shots,
    createdAt: set.createdAt,
  }
}

export const useRemixStore = create<RemixState>((set, get) => ({
  sets: [],
  activeSetId: null,
  step: 1,
  draft: emptyDraft(),
  listingLoading: false,
  listingNotice: null,

  loadSets: async () => {
    set({ sets: await remixSetStore.list() })
  },

  startNewSet: () => set({ draft: emptyDraft(), activeSetId: null, step: 1, listingNotice: null }),

  selectSet: (id) => {
    const target = get().sets.find((item) => item.id === id)
    if (!target) return
    set({ draft: draftFromSet(target), activeSetId: id, step: 1, listingNotice: null })
  },

  setStep: (step) => set({ step }),

  setName: (name) => set((s) => ({ draft: { ...s.draft, name } })),
  setListingUrl: (listingUrl) => set((s) => ({ draft: { ...s.draft, listingUrl } })),

  fetchListing: async () => {
    const url = get().draft.listingUrl.trim()
    if (!url) return
    if (!isClientCapabilityEnabled('remix:listing')) {
      set({ listingNotice: `链接抓取未开启，${UPLOAD_FALLBACK}` })
      return
    }

    set({ listingLoading: true, listingNotice: null })
    try {
      const listing = await fetchListingImages(url)
      const imageIds: string[] = []
      for (const image of listing.images) {
        const stored = await storeImageFromUrl(listingImageProxyUrl(image))
        imageIds.push(stored.id)
      }
      get().addCompetitorImages(imageIds)
      const name = listing.title ?? listing.asin
      if (!get().draft.name && name) get().setName(name)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      set({ listingNotice: `${reason}，${UPLOAD_FALLBACK}` })
    } finally {
      set({ listingLoading: false })
    }
  },

  importCompetitorFiles: async (files) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const stored = await storeImageFromFile(file, { compress: true })
        get().addCompetitorImages([stored.id])
      } catch (error) {
        useStore
          .getState()
          .showToast(
            `图片添加失败：${error instanceof Error ? error.message : String(error)}`,
            'error',
          )
      }
    }
  },

  addCompetitorImages: (imageIds) =>
    set((s) => ({
      draft: {
        ...s.draft,
        competitorImageIds: [
          ...s.draft.competitorImageIds,
          ...imageIds.filter((id) => !s.draft.competitorImageIds.includes(id)),
        ],
      },
    })),

  removeCompetitorImage: (imageId) =>
    set((s) => ({
      draft: {
        ...s.draft,
        competitorImageIds: s.draft.competitorImageIds.filter((id) => id !== imageId),
      },
    })),

  toggleProductAsset: (assetId) =>
    set((s) => {
      const selected = s.draft.productAssets.some((product) => product.assetId === assetId)
      return {
        draft: {
          ...s.draft,
          productAssets: selected
            ? s.draft.productAssets.filter((product) => product.assetId !== assetId)
            : [...s.draft.productAssets, { assetId, angle: DEFAULT_PRODUCT_ANGLE }],
        },
      }
    }),

  setProductAngle: (assetId, angle) =>
    set((s) => ({
      draft: {
        ...s.draft,
        productAssets: s.draft.productAssets.map((product) =>
          product.assetId === assetId ? { ...product, angle } : product,
        ),
      },
    })),

  updateSettings: (patch) =>
    set((s) => ({ draft: { ...s.draft, settings: { ...s.draft.settings, ...patch } } })),

  saveAndContinue: async () => {
    const { draft } = get()
    if (draft.competitorImageIds.length === 0) {
      useStore.getState().showToast('先放入至少一张竞品图', 'error')
      return
    }

    const now = Date.now()
    const listingUrl = draft.listingUrl.trim()
    const record: RemixSetRecord = {
      id: draft.id ?? crypto.randomUUID(),
      name: draft.name.trim() || `复刻套 ${get().sets.length + 1}`,
      source: {
        ...(listingUrl ? { listingUrl } : {}),
        competitorImageIds: draft.competitorImageIds,
      },
      productAssets: draft.productAssets,
      settings: draft.settings,
      shots: draft.shots,
      createdAt: draft.createdAt ?? now,
      updatedAt: now,
    }

    await remixSetStore.put(record)
    set((s) => ({
      sets: s.sets.some((item) => item.id === record.id)
        ? s.sets.map((item) => (item.id === record.id ? record : item))
        : [...s.sets, record],
      draft: draftFromSet(record),
      activeSetId: record.id,
      step: 2,
    }))
  },
}))

/** 所选产品素材里没有正面白底图时提示补图：镜头与底图角度不匹配，模型会改产品。 */
export function selectNeedsFrontAsset(state: RemixState): boolean {
  const { productAssets } = state.draft
  return productAssets.length > 0 && !productAssets.some((product) => product.angle === 'front')
}
