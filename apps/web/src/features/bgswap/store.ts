import type { ProductBox } from '@image-playground/shared'
import { create } from 'zustand'
import { getActiveApiProfile } from '../../lib/apiProfiles'
import { modelSupportsNativeMask } from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { storeImage } from '../../lib/db'
import { fetchListingImages, listingImageProxyUrl } from '../../lib/listingClient'
import {
  alphaToInpaintMask,
  alphaToMattePreview,
  assessMatte,
  matteAgreesWithBox,
  ProductMatteError,
  segmentProduct,
} from '../../lib/productMatte'
import {
  ensureImageCached,
  storeImageFromFile,
  storeImageFromUrl,
  submitPrepared,
  useStore,
} from '../../store'
import { pendingBatchImageIds } from './lib/batch'
import { bgSwapJobStore } from './lib/bgSwapJobStore'
import { requestBackgroundPlan, requestSceneScan } from './lib/planClient'
import { DIAGRAM_LABEL, isDiagram } from './lib/scene'
import type {
  BgSwapBatchItemState,
  BgSwapBatchProgress,
  BgSwapImage,
  BgSwapJobRecord,
  BgSwapStage,
  BgSwapVersion,
  MatteFailureCause,
  MatteOutcome,
} from './types'

const UPLOAD_FALLBACK = '请直接上传原图'
const UNMASKED_FALLBACK = '本版未抠图'
const MASK_UNSUPPORTED = `当前模型不支持遮罩，${UNMASKED_FALLBACK}`
const MATTE_FAILED = `抠图失败，${UNMASKED_FALLBACK}`
const MATTE_UNRELIABLE = `蒙版与产品框不符，${UNMASKED_FALLBACK}`
const NOT_SUBMITTED = '这张没有提交成功'

type Mask = { imageId: string; targetImageId: string }

export interface BgSwapDraft {
  /** 已保存的任务 id；null 表示还没落盘。 */
  id: string | null
  name: string
  images: BgSwapImage[]
  preference: string
  versionsPerImage: number
  createdAt: number | null
}

export interface BgSwapState {
  jobs: BgSwapJobRecord[]
  activeJobId: string | null
  draft: BgSwapDraft
  selectedImageId: string | null
  listingUrl: string
  listingLoading: boolean
  /** 抓图开始的时刻，用来读秒；不在抓图时为 null。 */
  listingStartedAt: number | null
  /** 抓图不可用时给出的回落说明，null 表示没有可说的。 */
  listingNotice: string | null

  /** 正在跑的那一段，null 表示没在出图。 */
  swapStage: BgSwapStage | null
  swapStartedAt: number | null
  swapNotice: string | null
  /** 中栏正在看的版本；null 表示看原图。 */
  previewVersionId: string | null
  /** 正在把哪一版的蒙版盖在原图上看；null 表示没在看蒙版。 */
  matteOverlayVersionId: string | null

  /** 这一轮批量的进度，null 表示这次打开还没跑过批量。 */
  batch: BgSwapBatchProgress | null

  loadJobs: () => Promise<void>
  startNewJob: () => void
  selectJob: (id: string) => void

  swapBackground: () => Promise<void>
  retryVersion: (versionId: string) => Promise<void>
  chooseVersion: (versionId: string) => void
  previewVersion: (versionId: string | null) => void
  toggleMatteOverlay: (versionId: string) => void

  runBatch: () => Promise<void>
  runBatchImage: (imageId: string) => Promise<void>
  stopBatch: () => void

  setListingUrl: (url: string) => void
  fetchListing: () => Promise<void>
  importFiles: (files: File[]) => Promise<void>
  removeImage: (imageId: string) => void
  selectImage: (imageId: string) => void

  setPreference: (preference: string) => void
  setVersionsPerImage: (count: number) => void
}

function emptyDraft(): BgSwapDraft {
  return {
    id: null,
    name: '',
    images: [],
    preference: '',
    versionsPerImage: 1,
    createdAt: null,
  }
}

function draftFromJob(job: BgSwapJobRecord): BgSwapDraft {
  return {
    id: job.id,
    name: job.name,
    images: job.images,
    preference: job.preference,
    versionsPerImage: job.versionsPerImage,
    createdAt: job.createdAt,
  }
}

export const useBgSwapStore = create<BgSwapState>((set, get) => ({
  jobs: [],
  activeJobId: null,
  draft: emptyDraft(),
  selectedImageId: null,
  listingUrl: '',
  listingLoading: false,
  listingStartedAt: null,
  listingNotice: null,
  swapStage: null,
  swapStartedAt: null,
  swapNotice: null,
  previewVersionId: null,
  matteOverlayVersionId: null,
  batch: null,

  loadJobs: async () => {
    set({ jobs: await bgSwapJobStore.list() })
  },

  startNewJob: () =>
    set({
      draft: emptyDraft(),
      activeJobId: null,
      selectedImageId: null,
      listingUrl: '',
      listingNotice: null,
      swapNotice: null,
      previewVersionId: null,
      matteOverlayVersionId: null,
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
      batch: null,
    })
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
      await persistDraft(set, get)
      await scanScenes(set, get)
    } catch (error) {
      set({ listingNotice: `${reasonOf(error)}，${UPLOAD_FALLBACK}` })
    } finally {
      set({ listingLoading: false, listingStartedAt: null })
    }
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
      swapNotice: null,
    }),

  setPreference: (preference) => patchDraft(set, get, { preference }),

  setVersionsPerImage: (versionsPerImage) => patchDraft(set, get, { versionsPerImage }),

  swapBackground: async () => {
    const { draft, selectedImageId, swapStage, batch } = get()
    const image = draft.images.find((item) => item.imageId === selectedImageId)
    const jobId = draft.id
    if (swapStage || batch?.running || !image || !jobId) return

    if (isDiagram(image.sceneType)) {
      useStore.getState().setConfirmDialog({
        title: '这张是示意图',
        message: `${DIAGRAM_LABEL}。`,
        confirmText: '仍要换背景',
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
    const image = draft.images.find((item) =>
      item.versions.some((version) => version.id === versionId),
    )
    const version = image?.versions.find((item) => item.id === versionId)
    const jobId = draft.id
    if (swapStage || batch?.running || !image || !version || !jobId) return

    await runStages(set, async (stage) => {
      const prepared = await prepareImage(get, image.imageId, stage, version)
      if (prepared.notice) set({ swapNotice: prepared.notice })
      const rerun = await submitVersion(jobId, prepared, versionId)
      if (rerun) await recordVersions(set, get, image.imageId, [rerun])
    })
  },

  chooseVersion: (versionId) => {
    set((s) => ({
      draft: {
        ...s.draft,
        images: s.draft.images.map((image) =>
          image.versions.some((version) => version.id === versionId)
            ? { ...image, chosenVersionId: versionId }
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

type SetState = (partial: Partial<BgSwapState> | ((s: BgSwapState) => Partial<BgSwapState>)) => void
type GetState = () => BgSwapState

function patchDraft(set: SetState, get: GetState, patch: Partial<BgSwapDraft>): void {
  set((s) => ({ draft: { ...s.draft, ...patch } }))
  void persistDraft(set, get)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单张出一版。确认对话框摆在中间，所以「有没有别的在跑」要在用户点完之后再看一次。 */
async function swapOneVersion(
  set: SetState,
  get: GetState,
  jobId: string,
  imageId: string,
): Promise<void> {
  const { swapStage, batch } = get()
  if (swapStage || batch?.running) return

  await runStages(set, async (stage) => {
    const prepared = await prepareImage(get, imageId, stage)
    if (prepared.notice) set({ swapNotice: prepared.notice })
    const version = await submitVersion(jobId, prepared, crypto.randomUUID())
    if (!version) return
    await recordVersions(set, get, imageId, [version])
    set({ previewVersionId: version.id })
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
  matte: MatteOutcome
  /** 蒙版叠在原图上的预览图；抠图没跑出结果时为 null。 */
  previewImageId: string | null
}

/** 一张图跑完方案与蒙版后的成果，同一张的每一版都拿它去提交。 */
interface PreparedImage extends MaskAttempt {
  imageId: string
  dataUrl: string
  plan: string
  prompt: string
  productBox: ProductBox | null
}

type StageSink = (stage: BgSwapStage) => void

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

/** 方案 → 蒙版，一张图只走一次，之后它的每一版共用。`reuse` 是重跑时沿用的旧方案。 */
async function prepareImage(
  get: GetState,
  imageId: string,
  stage: StageSink,
  reuse?: BgSwapVersion,
): Promise<PreparedImage> {
  if (!reuse) stage('plan')
  const dataUrl = await loadOriginal(imageId)
  const planned =
    reuse ?? (await requestBackgroundPlan({ image: dataUrl, preference: get().draft.preference }))
  const productBox = planned.productBox ?? null
  stage('matte')
  const attempt = await buildMask(imageId, dataUrl, productBox)
  stage('generate')
  return {
    ...attempt,
    imageId,
    dataUrl,
    plan: planned.plan,
    prompt: planned.prompt,
    productBox,
  }
}

/** 提交一次生成，拿回可落盘的版本；被提交门禁拦下时返回 null。 */
async function submitVersion(
  jobId: string,
  prepared: PreparedImage,
  versionId: string,
): Promise<BgSwapVersion | null> {
  const [taskId] = await submitPrepared({
    prompt: prepared.prompt,
    inputImages: [{ id: prepared.imageId, dataUrl: prepared.dataUrl }],
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
    matte: prepared.matte,
    ...(prepared.previewImageId ? { mattePreviewImageId: prepared.previewImageId } : {}),
    createdAt: Date.now(),
  }
}

async function recordVersions(
  set: SetState,
  get: GetState,
  imageId: string,
  versions: readonly BgSwapVersion[],
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
  patch: (image: BgSwapImage) => BgSwapImage,
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

function patchBatch(set: SetState, patch: Partial<BgSwapBatchProgress>): void {
  set((s) => (s.batch ? { batch: { ...s.batch, ...patch } } : {}))
}

function patchBatchItem(
  set: SetState,
  imageId: string,
  state: BgSwapBatchItemState,
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

function upsertVersion(versions: BgSwapVersion[], version: BgSwapVersion): BgSwapVersion[] {
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
    const mask = {
      imageId: await storeImage(alphaToInpaintMask(matte), 'mask'),
      targetImageId: imageId,
    }
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

function addImages(set: SetState, added: BgSwapImage[]): void {
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

/** 一张图都没有的任务不落盘：否则光是打字就会在任务列表里堆出空任务。 */
async function persistDraft(set: SetState, get: GetState): Promise<void> {
  const { draft, jobs } = get()
  if (draft.images.length === 0 && !draft.id) return

  const now = Date.now()
  const record: BgSwapJobRecord = {
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name.trim() || `换背景 ${jobs.length + 1}`,
    images: draft.images,
    preference: draft.preference,
    versionsPerImage: draft.versionsPerImage,
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
  }

  await bgSwapJobStore.put(record)
  set((s) => ({
    jobs: s.jobs.some((job) => job.id === record.id)
      ? s.jobs.map((job) => (job.id === record.id ? record : job))
      : [...s.jobs, record],
    draft: draftFromJob(record),
    activeJobId: record.id,
  }))
}
