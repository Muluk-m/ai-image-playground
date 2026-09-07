import {
  type BgSwapMode,
  DEFAULT_BG_SWAP_MODE,
  DEFAULT_PROMPT_LANGUAGE,
  type ProductBox,
  type PromptLanguage,
  type ShotType,
} from '@image-playground/shared'
import { create } from 'zustand'
import { analyzeCompetitorImages } from '../../lib/analyzeClient'
import { getActiveApiProfile } from '../../lib/apiProfiles'
import { modelSupportsNativeMask } from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { storeImage } from '../../lib/db'
import { eraseProductArea } from '../../lib/eraseProduct'
import { fetchListingImages, listingImageProxyUrl } from '../../lib/listingClient'
import {
  angleFromText,
  cameraToAngle,
  DEFAULT_PRODUCT_ANGLE,
  matchProductAsset,
  type ProductAngle,
  type ProductAsset,
  setProductAssetAngle,
  toggleProductAsset,
  UPLOAD_PRODUCT_ANGLE,
} from '../../lib/productAngle'
import {
  alphaToInpaintMask,
  alphaToMattePreview,
  alphaToProductMask,
  assessMatte,
  matteAgreesWithBox,
  ProductMatteError,
  segmentProduct,
} from '../../lib/productMatte'
import { productContextDescription } from '../../lib/shotPrompt'
import type {
  RemixBrief,
  RemixLevel,
  RemixProductDescription,
  RemixShotCopy,
} from '../../lib/shotTypes'
import {
  ensureImageCached,
  storeImageFromFile,
  storeImageFromUrl,
  submitPrepared,
  useStore,
} from '../../store'
import type { InputImage } from '../../types'
import { useLibraryStore } from '../library/store'
import type { AssetRecord } from '../library/types'
import { ACTION_LABELS, type ProductShotAction } from './lib/actions'
import { pendingBatchImageIds } from './lib/batch'
import { productShotJobStore } from './lib/jobStore'
import { legacyJobMode, type MaskSide, maskSideFor } from './lib/mode'
import { requestBackgroundPlan, requestSceneScan } from './lib/planClient'
import {
  buildRemixPlan,
  DEFAULT_REMIX_LEVEL,
  emptyProductDescription,
  type RemixPlanned,
  remixProductDescription,
} from './lib/remixPlan'
import { DIAGRAM_LABEL, isDiagram } from './lib/scene'
import {
  editVersionPlan,
  resetVersionPrompt,
  type VersionPlanContext,
  type VersionPlanPatch,
} from './lib/versionPlan'
import type {
  MatteFailureCause,
  MatteOutcome,
  ProductShotBatchItemState,
  ProductShotBatchProgress,
  ProductShotImage,
  ProductShotJob,
  ProductShotStage,
  ProductShotVersion,
  SourceMode,
} from './types'

const UPLOAD_FALLBACK = '请直接上传原图'
const UNMASKED_FALLBACK = '本版未抠图'
const MASK_UNSUPPORTED = `当前模型不支持遮罩，${UNMASKED_FALLBACK}`
const MATTE_FAILED = `抠图失败，${UNMASKED_FALLBACK}`
const MATTE_UNRELIABLE = `蒙版与产品框不符，${UNMASKED_FALLBACK}`
const NOT_SUBMITTED = '这张没有提交成功'
const NO_ASSET_PICKED = '请先选一张产品素材'
const ANALYZE_OFF = '竞品图分析未开启，这张跑不了借创意重做'
const NO_BRIEF = '这张没分析出可用的简报'
const NO_ANGLE_MATCH = '没有与机位相符的素材，用了第一张'
const ASSET_MISSING = '素材图片已丢失'

type Mask = { imageId: string; targetImageId: string }

export interface ProductShotsDraft {
  /** 已保存的任务 id；null 表示还没落盘。 */
  id: string | null
  name: string
  images: ProductShotImage[]
  preference: string
  versionsPerImage: number
  /** 最近一次跑的动作，重跑与批量都沿用它。 */
  mode: ProductShotAction
  /** 借创意重做与竞品的距离，批量沿用。 */
  level: RemixLevel
  productAssets: ProductAsset[]
  product: RemixProductDescription
  /** 图上文案的语言，整任务生效。 */
  language: PromptLanguage
  createdAt: number | null
}

export interface ProductShotsState {
  jobs: ProductShotJob[]
  activeJobId: string | null
  draft: ProductShotsDraft
  selectedImageId: string | null
  /** 左栏这一刻在用哪种来源。只是 UI 状态，不进任务记录。 */
  sourceMode: SourceMode
  listingUrl: string
  listingLoading: boolean
  /** 抓图开始的时刻，用来读秒；不在抓图时为 null。 */
  listingStartedAt: number | null
  /** 抓图不可用时给出的回落说明，null 表示没有可说的。 */
  listingNotice: string | null

  /** 正在跑的那一段，null 表示没在出图。 */
  swapStage: ProductShotStage | null
  swapStartedAt: number | null
  swapNotice: string | null
  /** 中栏正在看的版本；null 表示看原图。 */
  previewVersionId: string | null
  /** 正在把哪一版的蒙版盖在原图上看；null 表示没在看蒙版。 */
  matteOverlayVersionId: string | null
  /** 「查看方案」抽屉开在哪一版上；null 表示收起。 */
  planVersionId: string | null

  /** 这一轮批量的进度，null 表示这次打开还没跑过批量。 */
  batch: ProductShotBatchProgress | null

  /** 素材快捷弹层是否打开。 */
  productPickerOpen: boolean
  /** 从素材库挑原图的弹层是否打开。 */
  sourcePickerOpen: boolean

  loadJobs: () => Promise<void>
  startNewJob: () => void
  selectJob: (id: string) => void

  runAction: (mode: ProductShotAction) => Promise<void>
  retryVersion: (versionId: string) => Promise<void>
  regenerateFromVersion: (versionId: string) => Promise<void>
  chooseVersion: (versionId: string) => void
  previewVersion: (versionId: string | null) => void
  toggleMatteOverlay: (versionId: string) => void
  openPlanDrawer: (versionId: string) => void
  closePlanDrawer: () => void
  editVersionPlan: (versionId: string, patch: VersionPlanPatch) => void
  resetVersionPrompt: (versionId: string) => void

  runBatch: () => Promise<void>
  runBatchImage: (imageId: string) => Promise<void>
  stopBatch: () => void

  setSourceMode: (mode: SourceMode) => void
  setListingUrl: (url: string) => void
  fetchListing: () => Promise<void>
  importFiles: (files: File[]) => Promise<void>
  addImagesFromAssets: (assetIds: readonly string[]) => Promise<void>
  openSourcePicker: () => void
  closeSourcePicker: () => void
  removeImage: (imageId: string) => void
  selectImage: (imageId: string) => void

  setPreference: (preference: string) => void
  setVersionsPerImage: (count: number) => void
  setRemixLevel: (level: RemixLevel) => void
  setPromptLanguage: (language: PromptLanguage) => void

  setProductDescription: (patch: Partial<RemixProductDescription>) => void
  toggleProductAsset: (assetId: string) => void
  setProductAngle: (assetId: string, angle: ProductAngle) => void
  importProductFiles: (files: File[]) => Promise<void>
  openProductPicker: () => void
  closeProductPicker: () => void
}

function emptyDraft(): ProductShotsDraft {
  return {
    id: null,
    name: '',
    images: [],
    preference: '',
    versionsPerImage: 1,
    mode: DEFAULT_BG_SWAP_MODE,
    level: DEFAULT_REMIX_LEVEL,
    productAssets: [],
    product: emptyProductDescription(),
    language: DEFAULT_PROMPT_LANGUAGE,
    createdAt: null,
  }
}

function draftFromJob(job: ProductShotJob): ProductShotsDraft {
  return {
    id: job.id,
    name: job.name,
    images: job.images,
    preference: job.preference,
    versionsPerImage: job.versionsPerImage,
    mode: job.mode ?? legacyJobMode(job.productSource, job.target),
    level: job.level ?? DEFAULT_REMIX_LEVEL,
    productAssets: job.productAssets ?? [],
    product: job.product ?? emptyProductDescription(),
    language: job.language ?? DEFAULT_PROMPT_LANGUAGE,
    createdAt: job.createdAt,
  }
}

export const useProductShotsStore = create<ProductShotsState>((set, get) => ({
  jobs: [],
  activeJobId: null,
  draft: emptyDraft(),
  selectedImageId: null,
  sourceMode: 'upload',
  listingUrl: '',
  listingLoading: false,
  listingStartedAt: null,
  listingNotice: null,
  swapStage: null,
  swapStartedAt: null,
  swapNotice: null,
  previewVersionId: null,
  matteOverlayVersionId: null,
  planVersionId: null,
  batch: null,
  productPickerOpen: false,
  sourcePickerOpen: false,

  loadJobs: async () => {
    set({ jobs: await productShotJobStore.list() })
  },

  startNewJob: () =>
    set({
      draft: emptyDraft(),
      activeJobId: null,
      selectedImageId: null,
      sourceMode: 'upload',
      listingUrl: '',
      listingNotice: null,
      swapNotice: null,
      previewVersionId: null,
      matteOverlayVersionId: null,
      planVersionId: null,
      batch: null,
    }),

  selectJob: (id) => {
    const target = get().jobs.find((job) => job.id === id)
    if (!target) return
    set({
      draft: draftFromJob(target),
      activeJobId: id,
      selectedImageId: target.images[0]?.imageId ?? null,
      listingUrl: '',
      listingNotice: null,
      swapNotice: null,
      previewVersionId: null,
      matteOverlayVersionId: null,
      planVersionId: null,
      batch: null,
    })
  },

  setSourceMode: (sourceMode) => {
    set({ sourceMode })
    if (sourceMode === 'library') void useLibraryStore.getState().loadAssets()
  },

  setListingUrl: (listingUrl) => set({ listingUrl }),

  fetchListing: async () => {
    const url = get().listingUrl.trim()
    if (!url) return
    if (!isClientCapabilityEnabled('remix:listing')) {
      set({ listingNotice: `链接抓取未开启，${UPLOAD_FALLBACK}` })
      return
    }

    set({ listingLoading: true, listingStartedAt: Date.now(), listingNotice: null })
    let pulled = 0
    try {
      const listing = await fetchListingImages(url)
      const added = await Promise.all(
        listing.images.map(async (sourceUrl) => ({
          imageId: (await storeImageFromUrl(listingImageProxyUrl(sourceUrl))).id,
          sourceUrl,
          versions: [],
        })),
      )
      const name = listing.title ?? listing.asin
      set((s) => ({ draft: { ...s.draft, name: s.draft.name || name } }))
      addImages(set, added)
      pulled = added.length
      await persistDraft(set, get)
    } catch (error) {
      set({ listingNotice: `${reasonOf(error)}，${UPLOAD_FALLBACK}` })
    } finally {
      set({ listingLoading: false, listingStartedAt: null })
    }
    if (pulled === 0) return
    useStore.getState().showToast(`已拉入 ${pulled} 张`, 'success')
    // 预检逐张打上游，必须留在按钮复位之后：挪回 try 里图集已到齐按钮还在读秒。
    await scanScenes(set, get)
  },

  importFiles: async (files) => {
    for (const file of files.filter((item) => item.type.startsWith('image/'))) {
      try {
        const stored = await storeImageFromFile(file, { compress: true })
        addImages(set, [{ imageId: stored.id, versions: [] }])
      } catch (error) {
        useStore.getState().showToast(`图片添加失败：${reasonOf(error)}`, 'error')
      }
    }
    await persistDraft(set, get)
    await scanScenes(set, get)
  },

  addImagesFromAssets: async (assetIds) => {
    const { assets } = useLibraryStore.getState()
    const picked = assetIds.flatMap((assetId) => {
      const asset = assets.find((item) => item.id === assetId)
      return asset ? [asset] : []
    })
    const [first] = picked
    if (!first) return
    addImages(
      set,
      picked.map((asset) => ({ imageId: asset.imageId, versions: [] })),
    )
    adoptAsProduct(set, get, first)
    await persistDraft(set, get)
    await scanScenes(set, get)
  },

  openSourcePicker: () => {
    set({ sourcePickerOpen: true })
    void useLibraryStore.getState().loadAssets()
  },

  closeSourcePicker: () => set({ sourcePickerOpen: false }),

  removeImage: (imageId) => {
    set((s) => {
      const images = s.draft.images.filter((image) => image.imageId !== imageId)
      return {
        draft: { ...s.draft, images },
        selectedImageId:
          s.selectedImageId === imageId ? (images[0]?.imageId ?? null) : s.selectedImageId,
      }
    })
    void persistDraft(set, get)
  },

  selectImage: (selectedImageId) =>
    set({
      selectedImageId,
      previewVersionId: null,
      matteOverlayVersionId: null,
      planVersionId: null,
      swapNotice: null,
    }),

  setPreference: (preference) => patchDraft(set, get, { preference }),

  setVersionsPerImage: (versionsPerImage) => patchDraft(set, get, { versionsPerImage }),

  setRemixLevel: (level) => patchDraft(set, get, { level }),

  setPromptLanguage: (language) => patchDraft(set, get, { language }),

  setProductDescription: (patch) =>
    patchDraft(set, get, { product: { ...get().draft.product, ...patch } }),

  toggleProductAsset: (assetId) =>
    patchDraft(set, get, {
      productAssets: toggleProductAsset(get().draft.productAssets, assetId, DEFAULT_PRODUCT_ANGLE),
    }),

  setProductAngle: (assetId, angle) =>
    patchDraft(set, get, {
      productAssets: setProductAssetAngle(get().draft.productAssets, assetId, angle),
    }),

  importProductFiles: (files) =>
    useLibraryStore.getState().importAssetFiles(files, (asset) =>
      patchDraft(set, get, {
        productAssets: [
          ...get().draft.productAssets,
          { assetId: asset.id, angle: UPLOAD_PRODUCT_ANGLE },
        ],
      }),
    ),

  openProductPicker: () => {
    set({ productPickerOpen: true })
    void useLibraryStore.getState().loadAssets()
  },

  closeProductPicker: () => set({ productPickerOpen: false }),

  runAction: async (mode) => {
    const { draft, selectedImageId, swapStage, batch } = get()
    const image = draft.images.find((item) => item.imageId === selectedImageId)
    const jobId = draft.id
    if (swapStage || batch?.running || !image || !jobId) return
    patchDraft(set, get, { mode })

    if (isDiagram(image.sceneType)) {
      useStore.getState().setConfirmDialog({
        title: '这张是示意图',
        message: `${DIAGRAM_LABEL}。`,
        confirmText: `仍要${ACTION_LABELS[mode]}`,
        cancelText: '取消',
        showCancel: true,
        tone: 'warning',
        action: () => void swapOneVersion(set, get, jobId, image.imageId),
      })
      return
    }
    await swapOneVersion(set, get, jobId, image.imageId)
  },

  /** 重跑沿用这一版已有的方案与提示词，只换掉任务，版本条上不多出一条。 */
  retryVersion: async (versionId) => {
    const { draft, swapStage, batch } = get()
    const found = findVersion(draft, versionId)
    const jobId = draft.id
    if (swapStage || batch?.running || !found || !jobId) return

    await runStages(set, async (stage) => {
      const prepared = await prepareImage(get, found.imageId, stage, found.version)
      if (prepared.notice) set({ swapNotice: prepared.notice })
      const rerun = await submitVersion(jobId, prepared, versionId)
      if (rerun) await recordVersions(set, get, found.imageId, [rerun])
    })
  },

  /** 「按此重生成」：拿抽屉里这一版的提示词另起一版，遮罩与参考图照原动作再走一遍。 */
  regenerateFromVersion: async (versionId) => {
    const { draft } = get()
    const found = findVersion(draft, versionId)
    if (draft.id && found) await swapOneVersion(set, get, draft.id, found.imageId, found.version)
  },

  /** 再点已选的那版就是取消选用。 */
  chooseVersion: (versionId) => {
    set((s) => ({
      draft: {
        ...s.draft,
        images: s.draft.images.map((image) =>
          image.versions.some((version) => version.id === versionId)
            ? {
                ...image,
                chosenVersionId: image.chosenVersionId === versionId ? undefined : versionId,
              }
            : image,
        ),
      },
    }))
    void persistDraft(set, get)
  },

  previewVersion: (previewVersionId) => set({ previewVersionId }),

  toggleMatteOverlay: (versionId) =>
    set((s) => ({
      matteOverlayVersionId: s.matteOverlayVersionId === versionId ? null : versionId,
    })),

  openPlanDrawer: (planVersionId) => set({ planVersionId }),

  closePlanDrawer: () => set({ planVersionId: null }),

  editVersionPlan: (versionId, patch) =>
    patchVersion(set, get, versionId, (version, ctx) => editVersionPlan(version, patch, ctx)),

  resetVersionPrompt: (versionId) =>
    patchVersion(set, get, versionId, (version, ctx) => resetVersionPrompt(version, ctx)),

  runBatch: async () => {
    const { draft, selectedImageId } = get()
    const targets = pendingBatchImageIds(draft.images, selectedImageId)
    if (targets.length > 0) await runBatchOver(set, get, targets, targets)
  },

  /** 单张重跑接着上一轮的进度条走，其余图的状态不动。 */
  runBatchImage: async (imageId) => {
    const previous = get().batch?.items ?? []
    const items = previous.some((item) => item.imageId === imageId)
      ? previous.map((item) => item.imageId)
      : [...previous.map((item) => item.imageId), imageId]
    await runBatchOver(set, get, items, [imageId])
  },

  stopBatch: () => patchBatch(set, { stopRequested: true }),
}))

type SetState = (
  partial: Partial<ProductShotsState> | ((s: ProductShotsState) => Partial<ProductShotsState>),
) => void
type GetState = () => ProductShotsState

function patchDraft(set: SetState, get: GetState, patch: Partial<ProductShotsDraft>): void {
  set((s) => ({ draft: { ...s.draft, ...patch } }))
  void persistDraft(set, get)
}

/** 重算提示词要的任务级设定。画面类型取预检的结论：出方案那次模型判的没有留在版本上。 */
function versionContext(draft: ProductShotsDraft, image: ProductShotImage): VersionPlanContext {
  return {
    product: remixProductDescription(draft.product, firstAssetName(draft), draft.name),
    language: draft.language,
    preference: draft.preference,
    sceneType: image.sceneType ?? 'photo',
  }
}

function findVersion(
  draft: ProductShotsDraft,
  versionId: string,
): { imageId: string; image: ProductShotImage; version: ProductShotVersion } | null {
  for (const image of draft.images) {
    const version = image.versions.find((item) => item.id === versionId)
    if (version) return { imageId: image.imageId, image, version }
  }
  return null
}

function patchVersion(
  set: SetState,
  get: GetState,
  versionId: string,
  transform: (version: ProductShotVersion, ctx: VersionPlanContext) => ProductShotVersion,
): void {
  const { draft } = get()
  const found = findVersion(draft, versionId)
  if (!found) return

  const ctx = versionContext(draft, found.image)
  patchImage(set, found.imageId, (item) => ({
    ...item,
    versions: item.versions.map((version) =>
      version.id === versionId ? transform(version, ctx) : version,
    ),
  }))
  void persistDraft(set, get)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 单张出一版。确认对话框摆在中间，所以「有没有别的在跑」要在用户点完之后再看一次。
 * `reuse` 是抽屉里那一版：提交的是人挑定的提示词而不是新出的方案，所以新版一律算手改。
 */
async function swapOneVersion(
  set: SetState,
  get: GetState,
  jobId: string,
  imageId: string,
  reuse?: ProductShotVersion,
): Promise<void> {
  const { swapStage, batch } = get()
  if (swapStage || batch?.running) return

  await runStages(set, async (stage) => {
    const prepared = await prepareImage(get, imageId, stage, reuse)
    if (prepared.notice) set({ swapNotice: prepared.notice })
    const version = await submitVersion(jobId, prepared, crypto.randomUUID())
    if (!version) return
    await recordVersions(set, get, imageId, [reuse ? { ...version, promptEdited: true } : version])
    set({ previewVersionId: version.id, ...(reuse ? { planVersionId: version.id } : {}) })
  })
}

/** 预检刚进来的图，一张一张问画面类型；认不出来的按普通商品图走，不挡用户。 */
async function scanScenes(set: SetState, get: GetState): Promise<void> {
  if (!isClientCapabilityEnabled('remix:analyze')) return

  let scanned = false
  for (const image of get().draft.images) {
    if (image.sceneType) continue
    try {
      const sceneType = await requestSceneScan(await loadOriginal(image.imageId))
      patchImage(set, image.imageId, (item) => ({ ...item, sceneType }))
      scanned = true
    } catch {
      // 预检失败不该拦住换背景，这张就当普通商品图。
    }
  }
  if (scanned) await persistDraft(set, get)
}

async function loadOriginal(imageId: string): Promise<string> {
  const dataUrl = await ensureImageCached(imageId)
  if (!dataUrl) throw new Error('原图已不在本地')
  return dataUrl
}

interface MaskAttempt {
  mask: Mask | null
  /** 蒙版回落的说明，没有回落时为 null。 */
  notice: string | null
  /** 这一模式不带遮罩时为 null，没跑过抠图也就没有结论。 */
  matte: MatteOutcome | null
  /** 蒙版叠在原图上的预览图；抠图没跑出结果时为 null。 */
  previewImageId: string | null
}

/** 整图重画的那几种动作不带遮罩。 */
const NO_MASK: MaskAttempt = { mask: null, notice: null, matte: null, previewImageId: null }

/** 一张图跑完方案与蒙版后的成果，同一张的每一版都拿它去提交。 */
interface PreparedImage extends MaskAttempt {
  imageId: string
  plan: string
  prompt: string
  productBox: ProductBox | null
  mode: ProductShotAction
  /** 借创意重做的档位、简报、镜型与图上文案，其余动作没有。 */
  level?: RemixLevel
  brief?: RemixBrief
  shotType?: ShotType
  copy?: RemixShotCopy
  /** 沿用的那一版提示词是手改的，重跑时标记不能丢。 */
  promptEdited?: boolean
  /**
   * 提交时的参考图。换背景那三种第一张是原图（整图重画时是抹掉产品的那张）；
   * 借创意重做反过来，产品素材排第一。
   */
  inputImages: InputImage[]
  /** 换产品与借创意重做用掉的素材，只换背景时为 null。 */
  productAssetId: string | null
}

type StageSink = (stage: ProductShotStage) => void

/** 读秒的开关与失败说明只在这里写，段位由 body 自己推。 */
async function runStages(set: SetState, body: (stage: StageSink) => Promise<void>): Promise<void> {
  set({ swapStartedAt: Date.now(), swapNotice: null })
  try {
    await body((swapStage) => set({ swapStage }))
  } catch (error) {
    set({ swapNotice: reasonOf(error) })
  } finally {
    set({ swapStage: null, swapStartedAt: null })
  }
}

/** 重跑沿用这一版当时的动作，不受右栏之后被改成什么影响。 */
function modeOf(
  draft: ProductShotsDraft,
  reuse: ProductShotVersion | undefined,
): ProductShotAction {
  return reuse ? (reuse.mode ?? DEFAULT_BG_SWAP_MODE) : draft.mode
}

/** 按机位挑一张素材：挑不到同角度就用第一张，宁可角度差一点也别停在这里。 */
async function loadProductAsset(
  draft: ProductShotsDraft,
  camera: string,
  reuseAssetId: string | undefined,
): Promise<{ assetId: string; image: InputImage; notice: string | null }> {
  const matched = reuseAssetId
    ? (draft.productAssets.find((item) => item.assetId === reuseAssetId) ?? null)
    : matchProductAsset(cameraToAngle(camera), draft.productAssets)
  const picked = matched ?? draft.productAssets[0]
  if (!picked) throw new Error(NO_ASSET_PICKED)

  const record = useLibraryStore.getState().assets.find((item) => item.id === picked.assetId)
  const dataUrl = record ? await ensureImageCached(record.imageId) : null
  if (!record || !dataUrl) throw new Error(ASSET_MISSING)

  return {
    assetId: picked.assetId,
    image: { id: record.imageId, dataUrl },
    notice: matched ? null : NO_ANGLE_MATCH,
  }
}

/** 整图重画时原产品还留在画面里模型会照它画，所以先把那块抹成灰。 */
async function framingImage(
  imageId: string,
  dataUrl: string,
  productBox: ProductBox | null,
): Promise<InputImage> {
  if (!productBox) return { id: imageId, dataUrl }
  try {
    return await storeImageFromUrl(await eraseProductArea(dataUrl, productBox))
  } catch {
    return { id: imageId, dataUrl }
  }
}

/** 一张图只准备一次，之后它的每一版共用。`reuse` 是重跑时沿用的旧方案。 */
function prepareImage(
  get: GetState,
  imageId: string,
  stage: StageSink,
  reuse?: ProductShotVersion,
): Promise<PreparedImage> {
  const mode = modeOf(get().draft, reuse)
  return mode === 'remix'
    ? prepareRemix(get, imageId, stage, reuse)
    : prepareSwap(get, imageId, stage, mode, reuse)
}

/** 借创意重做：分析竞品图 → 六段提示词 → 抹掉产品的原图当参考，不带遮罩。 */
async function prepareRemix(
  get: GetState,
  imageId: string,
  stage: StageSink,
  reuse?: ProductShotVersion,
): Promise<PreparedImage> {
  const { draft } = get()
  const level = reuse?.level ?? draft.level
  if (!reuse) stage('plan')
  const dataUrl = await loadOriginal(imageId)
  const planned =
    reuse?.brief !== undefined
      ? {
          plan: reuse.plan,
          prompt: reuse.prompt,
          brief: reuse.brief,
          shotType: reuse.shotType,
          copy: reuse.copy,
        }
      : await planRemix(draft, dataUrl, level)
  const product = await loadProductAsset(draft, planned.brief.camera, reuse?.productAssetId)

  stage('generate')
  const productBox = planned.brief.productBox ?? null
  const framing = await framingImage(imageId, dataUrl, productBox)

  return {
    ...NO_MASK,
    notice: product.notice,
    imageId,
    plan: planned.plan,
    prompt: planned.prompt,
    productBox,
    mode: 'remix',
    level,
    brief: planned.brief,
    shotType: planned.shotType,
    copy: planned.copy,
    promptEdited: reuse?.promptEdited,
    // 六段提示词把序号写死成「图1是我方产品、图2是参考」，所以素材必须排第一。
    inputImages: [product.image, framing],
    productAssetId: product.assetId,
  }
}

async function planRemix(
  draft: ProductShotsDraft,
  dataUrl: string,
  level: RemixLevel,
): Promise<RemixPlanned> {
  if (!isClientCapabilityEnabled('remix:analyze')) throw new Error(ANALYZE_OFF)
  const product = remixProductDescription(draft.product, firstAssetName(draft), draft.name)
  const [brief] = await analyzeCompetitorImages([dataUrl], {
    name: product.name,
    description: productContextDescription(product),
  })
  if (!brief) throw new Error(NO_BRIEF)
  return buildRemixPlan({ brief, product, level, language: draft.language })
}

/** 产品名空着时拿第一张素材的名字顶上：工作台上只有它能说明这是什么产品。 */
function firstAssetName(draft: ProductShotsDraft): string {
  const picked = draft.productAssets[0]
  if (!picked) return ''
  return useLibraryStore.getState().assets.find((item) => item.id === picked.assetId)?.name ?? ''
}

/** 换背景那三种：方案 → 素材 → 蒙版。 */
async function prepareSwap(
  get: GetState,
  imageId: string,
  stage: StageSink,
  mode: BgSwapMode,
  reuse?: ProductShotVersion,
): Promise<PreparedImage> {
  const { draft } = get()
  if (!reuse) stage('plan')
  const dataUrl = await loadOriginal(imageId)
  const planned =
    reuse ?? (await requestBackgroundPlan({ image: dataUrl, preference: draft.preference, mode }))
  const productBox = planned.productBox ?? null

  const product =
    mode === 'background'
      ? null
      : await loadProductAsset(
          draft,
          'camera' in planned ? planned.camera : '',
          reuse?.productAssetId,
        )

  const side = maskSideFor(mode)
  if (side) stage('matte')
  const attempt = side ? await buildMask(imageId, dataUrl, productBox, side) : NO_MASK

  stage('generate')
  const original =
    mode === 'replace-and-background'
      ? await framingImage(imageId, dataUrl, productBox)
      : { id: imageId, dataUrl }

  return {
    ...attempt,
    notice: [product?.notice, attempt.notice].filter(Boolean).join('；') || null,
    imageId,
    plan: planned.plan,
    prompt: planned.prompt,
    productBox,
    mode,
    promptEdited: reuse?.promptEdited,
    inputImages: product ? [original, product.image] : [original],
    productAssetId: product?.assetId ?? null,
  }
}

/** 提交一次生成，拿回可落盘的版本；被提交门禁拦下时返回 null。 */
async function submitVersion(
  jobId: string,
  prepared: PreparedImage,
  versionId: string,
): Promise<ProductShotVersion | null> {
  const [taskId] = await submitPrepared({
    prompt: prepared.prompt,
    inputImages: prepared.inputImages,
    params: { ...useStore.getState().params, n: 1 },
    mask: prepared.mask,
    origin: { setId: jobId, shotId: `${prepared.imageId}:${versionId}` },
  })
  // 提交门禁拦下时没有任务 id，submitPrepared 已经解释过原因，这里不留空版本。
  if (!taskId) return null

  return {
    id: versionId,
    taskId,
    plan: prepared.plan,
    prompt: prepared.prompt,
    productBox: prepared.productBox,
    masked: prepared.mask !== null,
    mode: prepared.mode,
    ...(prepared.level ? { level: prepared.level } : {}),
    ...(prepared.brief ? { brief: prepared.brief } : {}),
    ...(prepared.shotType ? { shotType: prepared.shotType } : {}),
    ...(prepared.copy ? { copy: prepared.copy } : {}),
    ...(prepared.promptEdited ? { promptEdited: true } : {}),
    ...(prepared.productAssetId ? { productAssetId: prepared.productAssetId } : {}),
    ...(prepared.matte ? { matte: prepared.matte } : {}),
    ...(prepared.previewImageId ? { mattePreviewImageId: prepared.previewImageId } : {}),
    createdAt: Date.now(),
  }
}

async function recordVersions(
  set: SetState,
  get: GetState,
  imageId: string,
  versions: readonly ProductShotVersion[],
): Promise<void> {
  patchImage(set, imageId, (image) => ({
    ...image,
    versions: versions.reduce(upsertVersion, image.versions),
  }))
  await persistDraft(set, get)
}

function patchImage(
  set: SetState,
  imageId: string,
  patch: (image: ProductShotImage) => ProductShotImage,
): void {
  set((s) => ({
    draft: {
      ...s.draft,
      images: s.draft.images.map((image) => (image.imageId === imageId ? patch(image) : image)),
    },
  }))
}

/** 起一轮批量：`listed` 是进度条上要列出的图，`targets` 是这轮真去跑的，一张跑完再跑下一张。 */
async function runBatchOver(
  set: SetState,
  get: GetState,
  listed: readonly string[],
  targets: readonly string[],
): Promise<void> {
  const { draft, swapStage, batch } = get()
  const jobId = draft.id
  if (swapStage || batch?.running || !jobId) return

  const previous = new Map((batch?.items ?? []).map((item) => [item.imageId, item]))
  set({
    batch: {
      items: listed.map((imageId) => {
        const kept = targets.includes(imageId) ? undefined : previous.get(imageId)
        return kept ?? { imageId, state: 'pending', error: null }
      }),
      running: true,
      stopRequested: false,
      startedAt: Date.now(),
      stage: null,
    },
  })

  for (const imageId of targets) {
    if (get().batch?.stopRequested) break
    await runOneOfBatch(set, get, jobId, imageId)
  }

  patchBatch(set, { running: false, stage: null })
}

/** 批量里的一张：同一张的多版一起提交，跨图由调用方串起来。 */
async function runOneOfBatch(
  set: SetState,
  get: GetState,
  jobId: string,
  imageId: string,
): Promise<void> {
  patchBatchItem(set, imageId, 'running', null)
  try {
    const prepared = await prepareImage(get, imageId, (stage) => patchBatch(set, { stage }))
    const submitted = await Promise.all(
      Array.from({ length: get().draft.versionsPerImage }, () =>
        submitVersion(jobId, prepared, crypto.randomUUID()),
      ),
    )
    const versions = submitted.filter((version) => version !== null)
    if (versions.length === 0) throw new Error(NOT_SUBMITTED)
    await recordVersions(set, get, imageId, versions)
    patchBatchItem(set, imageId, 'done', null)
  } catch (error) {
    patchBatchItem(set, imageId, 'error', reasonOf(error))
  }
}

function patchBatch(set: SetState, patch: Partial<ProductShotBatchProgress>): void {
  set((s) => (s.batch ? { batch: { ...s.batch, ...patch } } : {}))
}

function patchBatchItem(
  set: SetState,
  imageId: string,
  state: ProductShotBatchItemState,
  error: string | null,
): void {
  set((s) =>
    s.batch
      ? {
          batch: {
            ...s.batch,
            items: s.batch.items.map((item) =>
              item.imageId === imageId ? { ...item, state, error } : item,
            ),
          },
        }
      : {},
  )
}

function upsertVersion(
  versions: ProductShotVersion[],
  version: ProductShotVersion,
): ProductShotVersion[] {
  return versions.some((item) => item.id === version.id)
    ? versions.map((item) => (item.id === version.id ? version : item))
    : [...versions, version]
}

function unmasked(
  notice: string,
  reason: MatteFailureCause,
  previewImageId: string | null,
): MaskAttempt {
  return { mask: null, notice, matte: { ok: false, reason }, previewImageId }
}

/** 抠不出来就回落提示词版：宁可产品不锁死，也不要卡住这一版。`notice` 是回落的说明。 */
async function buildMask(
  imageId: string,
  dataUrl: string,
  productBox: ProductBox | null,
  side: MaskSide,
): Promise<MaskAttempt> {
  if (
    !modelSupportsNativeMask(getActiveApiProfile(useStore.getState().settings), getPublicChannels())
  ) {
    return unmasked(MASK_UNSUPPORTED, 'unsupported', null)
  }
  try {
    const matte = await segmentProduct(dataUrl)
    // 预览图连抠错的那次也要存：用户就是靠它看出抠错了什么。
    const previewImageId = await storeImage(alphaToMattePreview(matte), 'mask')
    if (!assessMatte(matte).ok) return unmasked(MATTE_FAILED, 'failed', previewImageId)
    if (!matteAgreesWithBox(matte, productBox)) {
      return unmasked(MATTE_UNRELIABLE, 'box-mismatch', previewImageId)
    }
    const pixels = side === 'product' ? alphaToProductMask(matte) : alphaToInpaintMask(matte)
    const mask = { imageId: await storeImage(pixels, 'mask'), targetImageId: imageId }
    return {
      mask,
      notice: null,
      matte: { ok: true, backend: matte.backend, elapsedMs: matte.elapsedMs },
      previewImageId,
    }
  } catch (error) {
    const reason = error instanceof ProductMatteError ? error.reason : 'failed'
    return unmasked(MATTE_FAILED, reason, null)
  }
}

function addImages(set: SetState, added: ProductShotImage[]): void {
  set((s) => {
    const fresh = added.filter(
      (image) => !s.draft.images.some((existing) => existing.imageId === image.imageId),
    )
    const images = [...s.draft.images, ...fresh]
    return {
      draft: { ...s.draft, images },
      selectedImageId: s.selectedImageId ?? images[0]?.imageId ?? null,
    }
  })
}

/** 素材库同时是原图与产品的来源，选完原图用户以为产品也选过了；产品还空着就认领第一张。 */
function adoptAsProduct(set: SetState, get: GetState, asset: AssetRecord): void {
  if (get().draft.productAssets.length > 0) return
  const angle = angleFromText(asset.name) ?? UPLOAD_PRODUCT_ANGLE
  set((s) => ({ draft: { ...s.draft, productAssets: [{ assetId: asset.id, angle }] } }))
  useStore.getState().showToast(`已把「${asset.name}」设为我的产品，可在上方更换`, 'success')
}

/** 一张图都没有的任务不落盘：否则光是打字就会在任务列表里堆出空任务。 */
async function persistDraft(set: SetState, get: GetState): Promise<void> {
  const { draft, jobs } = get()
  if (draft.images.length === 0 && !draft.id) return

  const now = Date.now()
  const record: ProductShotJob = {
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name.trim() || `商品图 ${jobs.length + 1}`,
    images: draft.images,
    preference: draft.preference,
    versionsPerImage: draft.versionsPerImage,
    mode: draft.mode,
    level: draft.level,
    productAssets: draft.productAssets,
    product: draft.product,
    language: draft.language,
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
  }

  await productShotJobStore.put(record)
  set((s) => ({
    jobs: s.jobs.some((job) => job.id === record.id)
      ? s.jobs.map((job) => (job.id === record.id ? record : job))
      : [...s.jobs, record],
    draft: draftFromJob(record),
    activeJobId: record.id,
  }))
}
