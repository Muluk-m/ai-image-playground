import type { CompetitorBrief } from '@image-playground/shared'
import { create } from 'zustand'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { ensureImageCached, storeImageFromFile, storeImageFromUrl, useStore } from '../../store'
import { useLibraryStore } from '../library/store'
import { analyzeCompetitorImages } from './lib/analyzeClient'
import { eraseProductArea } from './lib/eraseProduct'
import { fetchListingImages, listingImageProxyUrl } from './lib/listingClient'
import { productContextDescription } from './lib/prompt'
import { remixSetStore } from './lib/remixSetStore'
import {
  applyShotPatch,
  createBlankShot,
  createShot,
  productImageResolver,
  regenerateShotPrompt,
  type RemixShotPatch,
  type ShotContext,
} from './lib/shots'
import type {
  ProductAngle,
  RemixProductAsset,
  RemixProductDescription,
  RemixSetRecord,
  RemixSetSettings,
  RemixShot,
} from './types'

export type RemixStep = 1 | 2 | 3

const UPLOAD_FALLBACK = '请直接上传竞品图'
const DEFAULT_PRODUCT_ANGLE: ProductAngle = 'three-quarter'
const ANALYZE_FALLBACK = '可以手写简报与提示词'
const DEFAULT_SETTINGS: RemixSetSettings = {
  platform: 'amazon',
  language: 'zh',
  level: 'high',
  product: { name: '', features: '', mainColor: '', forbiddenColors: [] },
}

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
  analyzing: boolean
  /** 分析不可用时给出的回落说明，null 表示没有可说的。 */
  analyzeNotice: string | null

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
  updateProduct: (patch: Partial<RemixProductDescription>) => void

  saveAndContinue: () => Promise<void>

  analyzeShots: () => Promise<void>
  updateShot: (shotId: string, patch: RemixShotPatch) => void
  resetShotPrompt: (shotId: string) => void
  saveShotsAndContinue: () => Promise<void>
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
  analyzing: false,
  analyzeNotice: null,

  loadSets: async () => {
    set({ sets: await remixSetStore.list() })
  },

  startNewSet: () =>
    set({
      draft: emptyDraft(),
      activeSetId: null,
      step: 1,
      listingNotice: null,
      analyzeNotice: null,
    }),

  selectSet: (id) => {
    const target = get().sets.find((item) => item.id === id)
    if (!target) return
    set({
      draft: draftFromSet(target),
      activeSetId: id,
      step: 1,
      listingNotice: null,
      analyzeNotice: null,
    })
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
      const stored = await Promise.all(
        listing.images.map((image) => storeImageFromUrl(listingImageProxyUrl(image))),
      )
      get().addCompetitorImages(stored.map((image) => image.id))
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

  updateProduct: (patch) =>
    set((s) => ({
      draft: {
        ...s.draft,
        settings: { ...s.draft.settings, product: { ...s.draft.settings.product, ...patch } },
      },
    })),

  saveAndContinue: async () => {
    const { draft } = get()
    if (draft.competitorImageIds.length === 0) {
      useStore.getState().showToast('先放入至少一张竞品图', 'error')
      return
    }

    await persistDraft(set, get)
    set({ step: 2 })
  },

  analyzeShots: async () => {
    const { draft } = get()
    if (draft.competitorImageIds.length === 0) {
      useStore.getState().showToast('先放入至少一张竞品图', 'error')
      return
    }

    if (!isClientCapabilityEnabled('remix:analyze')) {
      await fillBlankShots(set, get, `竞品图分析未开启，${ANALYZE_FALLBACK}`)
      return
    }

    set({ analyzing: true, analyzeNotice: null })
    try {
      const sources = await loadCompetitorImages(draft.competitorImageIds)
      const briefs = await analyzeCompetitorImages(
        sources.map((source) => source.dataUrl),
        productContext(draft),
      )
      const context = shotContext(get)
      const shots: RemixShot[] = []
      for (const [index, brief] of briefs.entries()) {
        const source = sources[index]
        if (!source) continue
        const referenceImageId = await storeReferenceImage(source, brief)
        shots.push(createShot(source.imageId, brief, referenceImageId, context))
      }
      set((s) => ({ draft: { ...s.draft, shots } }))
      await persistDraft(set, get)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await fillBlankShots(set, get, `${reason}，${ANALYZE_FALLBACK}`)
    } finally {
      set({ analyzing: false })
    }
  },

  updateShot: (shotId, patch) => {
    const context = shotContext(get)
    set((s) => ({
      draft: {
        ...s.draft,
        shots: s.draft.shots.map((shot) =>
          shot.id === shotId ? applyShotPatch(shot, patch, context) : shot,
        ),
      },
    }))
  },

  resetShotPrompt: (shotId) => {
    const context = shotContext(get)
    set((s) => ({
      draft: {
        ...s.draft,
        shots: s.draft.shots.map((shot) =>
          shot.id === shotId ? regenerateShotPrompt(shot, context) : shot,
        ),
      },
    }))
  },

  saveShotsAndContinue: async () => {
    await persistDraft(set, get)
    set({ step: 3 })
  },
}))

type SetState = (partial: Partial<RemixState> | ((s: RemixState) => Partial<RemixState>)) => void
type GetState = () => RemixState

async function persistDraft(set: SetState, get: GetState): Promise<void> {
  const { draft, sets } = get()
  const now = Date.now()
  const listingUrl = draft.listingUrl.trim()
  const record: RemixSetRecord = {
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name.trim() || `复刻套 ${sets.length + 1}`,
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
  }))
}

function shotContext(get: GetState): ShotContext {
  const { draft } = get()
  const assets = useLibraryStore.getState().assets
  return {
    settings: draft.settings,
    productImageFor: productImageResolver(
      draft.productAssets,
      (assetId) => assets.find((asset) => asset.id === assetId)?.imageId,
    ),
  }
}

function productContext(draft: RemixDraft): { name: string; description: string } {
  const { product } = draft.settings
  return {
    name: product.name.trim() || draft.name.trim() || '本产品',
    description: productContextDescription(product),
  }
}

interface CompetitorImage {
  imageId: string
  dataUrl: string
}

async function loadCompetitorImages(imageIds: string[]): Promise<CompetitorImage[]> {
  const loaded = await Promise.all(
    imageIds.map(async (imageId) => {
      const dataUrl = await ensureImageCached(imageId)
      return dataUrl ? { imageId, dataUrl } : null
    }),
  )
  return loaded.filter((image): image is CompetitorImage => image !== null)
}

/** 抹不掉产品时退回原图：宁可让人自己核对，也不要卡住整轮分析。 */
async function storeReferenceImage(
  source: CompetitorImage,
  brief: CompetitorBrief,
): Promise<string> {
  if (!brief.productBox) return source.imageId
  try {
    const erased = await eraseProductArea(source.dataUrl, brief.productBox)
    return (await storeImageFromUrl(erased)).id
  } catch {
    return source.imageId
  }
}

/** 已经有镜头时只留说明，不拿空白镜头覆盖人写过的东西。 */
async function fillBlankShots(set: SetState, get: GetState, notice: string): Promise<void> {
  const { draft } = get()
  if (draft.shots.length > 0) {
    set({ analyzeNotice: notice })
    return
  }
  const context = shotContext(get)
  const shots = draft.competitorImageIds.map((imageId) => createBlankShot(imageId, context))
  set((s) => ({ draft: { ...s.draft, shots }, analyzeNotice: notice }))
  await persistDraft(set, get)
}

/** 所选产品素材里没有正面白底图时提示补图：镜头与底图角度不匹配，模型会改产品。 */
export function selectNeedsFrontAsset(state: RemixState): boolean {
  const { productAssets } = state.draft
  return productAssets.length > 0 && !productAssets.some((product) => product.angle === 'front')
}
