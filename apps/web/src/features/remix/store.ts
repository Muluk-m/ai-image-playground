import {
  type BackgroundPreset,
  type CompetitorBrief,
  findBackgroundPreset,
  type ProductContext,
} from '@image-playground/shared'
import { create } from 'zustand'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import {
  ensureImageCached,
  storeImageFromFile,
  storeImageFromUrl,
  submitPrepared,
  useStore,
} from '../../store'
import type { InputImage } from '../../types'
import { useLibraryStore } from '../library/store'
import { analyzeCompetitorImages } from './lib/analyzeClient'
import { eraseProductArea } from './lib/eraseProduct'
import { fetchListingImages, listingImageProxyUrl } from './lib/listingClient'
import { productContextDescription } from './lib/prompt'
import { remixSetStore } from './lib/remixSetStore'
import {
  applyShotPatch,
  expandOwnShots as buildOwnShots,
  canGenerateShot,
  createBlankShot,
  createShot,
  productImageResolver,
  type RemixShotPatch,
  regenerateShotPrompt,
  type ShotContext,
} from './lib/shots'
import type {
  ProductAngle,
  RemixProductAsset,
  RemixProductDescription,
  RemixSetRecord,
  RemixSetSettings,
  RemixShot,
  RemixSourceKind,
} from './types'

export type RemixStep = 1 | 2 | 3

const UPLOAD_FALLBACK = '请直接上传竞品图'
const CUSTOM_BACKGROUND_ID = 'custom'
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
  sourceKind: RemixSourceKind
  listingUrl: string
  sourceImageIds: string[]
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
  /** `own` 套步骤②选中的背景风格。 */
  backgroundStyleIds: string[]
  customBackground: string
  perShotCount: number
  generating: boolean
  /** 本轮排到但还没提交的镜头，刷新后不恢复。 */
  queuedShotIds: string[]

  loadSets: () => Promise<void>
  startNewSet: () => void
  selectSet: (id: string) => void
  setStep: (step: RemixStep) => void

  setName: (name: string) => void
  setSourceKind: (kind: RemixSourceKind) => void
  setListingUrl: (url: string) => void
  fetchListing: () => Promise<void>
  importSourceFiles: (files: File[]) => Promise<void>
  addSourceImages: (imageIds: string[]) => void
  removeSourceImage: (imageId: string) => void

  toggleProductAsset: (assetId: string) => void
  setProductAngle: (assetId: string, angle: ProductAngle) => void
  updateSettings: (patch: Partial<RemixSetSettings>) => void
  updateProduct: (patch: Partial<RemixProductDescription>) => void

  saveAndContinue: () => Promise<void>

  analyzeShots: () => Promise<void>
  toggleBackgroundStyle: (styleId: string) => void
  setCustomBackground: (text: string) => void
  expandOwnShots: () => Promise<void>
  updateShot: (shotId: string, patch: RemixShotPatch) => void
  resetShotPrompt: (shotId: string) => void
  saveShotsAndContinue: () => Promise<void>

  setPerShotCount: (count: number) => void
  generateSet: () => Promise<void>
  regenerateShot: (shotId: string) => Promise<void>
}

function emptyDraft(): RemixDraft {
  return {
    id: null,
    name: '',
    sourceKind: 'competitor',
    listingUrl: '',
    sourceImageIds: [],
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
    sourceKind: set.source.kind === 'own' ? 'own' : 'competitor',
    listingUrl: set.source.listingUrl ?? '',
    sourceImageIds: [...set.source.sourceImageIds],
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
  backgroundStyleIds: [],
  customBackground: '',
  perShotCount: 1,
  generating: false,
  queuedShotIds: [],

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
      backgroundStyleIds: [],
      customBackground: '',
      queuedShotIds: [],
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
      queuedShotIds: [],
    })
  },

  setStep: (step) => set({ step }),

  setName: (name) => set((s) => ({ draft: { ...s.draft, name } })),
  setSourceKind: (sourceKind) => set((s) => ({ draft: { ...s.draft, sourceKind } })),
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
      get().addSourceImages(stored.map((image) => image.id))
      const name = listing.title ?? listing.asin
      if (!get().draft.name && name) get().setName(name)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      set({ listingNotice: `${reason}，${UPLOAD_FALLBACK}` })
    } finally {
      set({ listingLoading: false })
    }
  },

  importSourceFiles: async (files) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const stored = await storeImageFromFile(file, { compress: true })
        get().addSourceImages([stored.id])
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

  addSourceImages: (imageIds) =>
    set((s) => ({
      draft: {
        ...s.draft,
        sourceImageIds: [
          ...s.draft.sourceImageIds,
          ...imageIds.filter((id) => !s.draft.sourceImageIds.includes(id)),
        ],
      },
    })),

  removeSourceImage: (imageId) =>
    set((s) => ({
      draft: {
        ...s.draft,
        sourceImageIds: s.draft.sourceImageIds.filter((id) => id !== imageId),
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
    if (draft.sourceImageIds.length === 0) {
      useStore.getState().showToast('先放入至少一张图', 'error')
      return
    }

    await persistDraft(set, get)
    set({ step: 2 })
  },

  analyzeShots: async () => {
    const { draft } = get()
    if (draft.sourceImageIds.length === 0) {
      useStore.getState().showToast('先放入至少一张竞品图', 'error')
      return
    }

    if (!isClientCapabilityEnabled('remix:analyze')) {
      await fillBlankShots(set, get, `竞品图分析未开启，${ANALYZE_FALLBACK}`)
      return
    }

    set({ analyzing: true, analyzeNotice: null })
    try {
      const sources = await loadSourceImages(draft.sourceImageIds)
      const briefs = await analyzeCompetitorImages(
        sources.map((source) => source.dataUrl),
        productContext(draft),
      )
      const context = shotContext(get)
      const analysed = briefs.flatMap((brief, index) => {
        const source = sources[index]
        return source ? [{ source, brief }] : []
      })
      const shots = await Promise.all(
        analysed.map(async ({ source, brief }) =>
          createShot(source.imageId, brief, await storeReferenceImage(source, brief), context),
        ),
      )
      set((s) => ({ draft: { ...s.draft, shots } }))
      await persistDraft(set, get)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await fillBlankShots(set, get, `${reason}，${ANALYZE_FALLBACK}`)
    } finally {
      set({ analyzing: false })
    }
  },

  toggleBackgroundStyle: (styleId) =>
    set((s) => ({
      backgroundStyleIds: s.backgroundStyleIds.includes(styleId)
        ? s.backgroundStyleIds.filter((id) => id !== styleId)
        : [...s.backgroundStyleIds, styleId],
    })),

  setCustomBackground: (customBackground) => set({ customBackground }),

  expandOwnShots: async () => {
    const styles = selectBackgroundStyles(get())
    if (styles.length === 0) {
      useStore.getState().showToast('先选一个背景风格', 'error')
      return
    }
    const { draft } = get()
    const shots = buildOwnShots(draft.sourceImageIds, styles, shotContext(get))
    set((s) => ({ draft: { ...s.draft, shots } }))
    await persistDraft(set, get)
  },

  updateShot: (shotId, patch) => {
    const context = shotContext(get)
    mapShot(set, shotId, (shot) => applyShotPatch(shot, patch, context))
  },

  resetShotPrompt: (shotId) => {
    const context = shotContext(get)
    mapShot(set, shotId, (shot) => regenerateShotPrompt(shot, context))
  },

  saveShotsAndContinue: async () => {
    await persistDraft(set, get)
    set({ step: 3 })
  },

  setPerShotCount: (count) => set({ perShotCount: Math.max(1, Math.round(count)) }),

  generateSet: async () => {
    const runnable = get().draft.shots.filter((shot) => shot.enabled && canGenerateShot(shot))
    if (runnable.length === 0) {
      useStore.getState().showToast('先勾选要生成的镜头', 'error')
      return
    }

    set({ generating: true, queuedShotIds: runnable.map((shot) => shot.id) })
    try {
      for (const shot of runnable) {
        set((s) => ({ queuedShotIds: s.queuedShotIds.filter((id) => id !== shot.id) }))
        await submitShot(set, get, shot.id)
      }
    } finally {
      set({ generating: false, queuedShotIds: [] })
    }
  },

  regenerateShot: async (shotId) => {
    await submitShot(set, get, shotId)
  },
}))

type SetState = (partial: Partial<RemixState> | ((s: RemixState) => Partial<RemixState>)) => void
type GetState = () => RemixState

function mapShot(set: SetState, shotId: string, transform: (shot: RemixShot) => RemixShot): void {
  set((s) => ({
    draft: {
      ...s.draft,
      shots: s.draft.shots.map((shot) => (shot.id === shotId ? transform(shot) : shot)),
    },
  }))
}

async function persistDraft(set: SetState, get: GetState): Promise<void> {
  const { draft, sets } = get()
  const now = Date.now()
  const listingUrl = draft.listingUrl.trim()
  const record: RemixSetRecord = {
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name.trim() || `复刻套 ${sets.length + 1}`,
    source: {
      kind: draft.sourceKind,
      ...(listingUrl ? { listingUrl } : {}),
      sourceImageIds: draft.sourceImageIds,
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

/** 用户自写的一条当成没有地面与配件的预设，与预设走同一条展开路径。 */
function selectBackgroundStyles(state: RemixState): BackgroundPreset[] {
  const presets = state.backgroundStyleIds.flatMap((id) => {
    const preset = findBackgroundPreset(id)
    return preset ? [preset] : []
  })
  const custom = state.customBackground.trim()
  if (!custom) return presets
  return [
    ...presets,
    { id: CUSTOM_BACKGROUND_ID, label: '自定义', wall: custom, floor: '', props: [] },
  ]
}

async function loadInputImages(shot: RemixShot): Promise<InputImage[]> {
  const ids = [shot.productImageId, shot.referenceImageId].filter(
    (id): id is string => typeof id === 'string',
  )
  const loaded = await Promise.all(
    ids.map(async (id) => {
      const dataUrl = await ensureImageCached(id)
      return dataUrl ? { id, dataUrl } : null
    }),
  )
  return loaded.filter((image): image is InputImage => image !== null)
}

/** 一镜一次提交：每镜的张数各自过提交门禁，不受单次批量上限约束。 */
async function submitShot(set: SetState, get: GetState, shotId: string): Promise<void> {
  const { draft, perShotCount } = get()
  const shot = draft.shots.find((item) => item.id === shotId)
  const setId = draft.id
  if (!shot || !setId || !canGenerateShot(shot)) return

  const taskIds = await submitPrepared({
    prompt: shot.prompt,
    inputImages: await loadInputImages(shot),
    params: { ...useStore.getState().params, n: perShotCount },
    origin: { setId, shotId: shot.id },
  })
  if (taskIds.length === 0) return

  mapShot(set, shotId, (current) => ({ ...current, taskIds }))
  await persistDraft(set, get)
}

function shotContext(get: GetState): ShotContext {
  const { draft } = get()
  const assets = useLibraryStore.getState().assets
  return {
    settings: draft.settings,
    sourceKind: draft.sourceKind,
    productImageFor: productImageResolver(
      draft.productAssets,
      (assetId) => assets.find((asset) => asset.id === assetId)?.imageId,
    ),
  }
}

function productContext(draft: RemixDraft): ProductContext {
  const { product } = draft.settings
  return {
    name: product.name.trim() || draft.name.trim() || '本产品',
    description: productContextDescription(product),
  }
}

interface SourceImage {
  imageId: string
  dataUrl: string
}

async function loadSourceImages(imageIds: string[]): Promise<SourceImage[]> {
  const loaded = await Promise.all(
    imageIds.map(async (imageId) => {
      const dataUrl = await ensureImageCached(imageId)
      return dataUrl ? { imageId, dataUrl } : null
    }),
  )
  return loaded.filter((image): image is SourceImage => image !== null)
}

/** 抹不掉产品时退回原图：宁可让人自己核对，也不要卡住整轮分析。 */
async function storeReferenceImage(source: SourceImage, brief: CompetitorBrief): Promise<string> {
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
  const shots = draft.sourceImageIds.map((imageId) => createBlankShot(imageId, context))
  set((s) => ({ draft: { ...s.draft, shots }, analyzeNotice: notice }))
  await persistDraft(set, get)
}

/** 所选产品素材里没有正面白底图时提示补图：镜头与底图角度不匹配，模型会改产品。 */
export function selectNeedsFrontAsset(state: RemixState): boolean {
  const { productAssets } = state.draft
  return productAssets.length > 0 && !productAssets.some((product) => product.angle === 'front')
}
