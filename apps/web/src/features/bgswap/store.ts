import { create } from 'zustand'
import { getActiveApiProfile } from '../../lib/apiProfiles'
import { modelSupportsNativeMask } from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { storeImage } from '../../lib/db'
import { fetchListingImages, listingImageProxyUrl } from '../../lib/listingClient'
import { alphaToInpaintMask, assessMatte, segmentProduct } from '../../lib/productMatte'
import {
  ensureImageCached,
  storeImageFromFile,
  storeImageFromUrl,
  submitPrepared,
  useStore,
} from '../../store'
import { bgSwapJobStore } from './lib/bgSwapJobStore'
import { requestBackgroundPlan } from './lib/planClient'
import type { BgSwapImage, BgSwapJobRecord, BgSwapStage, BgSwapVersion } from './types'

const UPLOAD_FALLBACK = '请直接上传原图'
const UNMASKED_FALLBACK = '本版未抠图'
const MASK_UNSUPPORTED = `当前模型不支持遮罩，${UNMASKED_FALLBACK}`
const MATTE_FAILED = `抠图失败，${UNMASKED_FALLBACK}`

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

  loadJobs: () => Promise<void>
  startNewJob: () => void
  selectJob: (id: string) => void

  swapBackground: () => Promise<void>
  retryVersion: (versionId: string) => Promise<void>
  chooseVersion: (versionId: string) => void
  previewVersion: (versionId: string | null) => void

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
    set({ selectedImageId, previewVersionId: null, swapNotice: null }),

  setPreference: (preference) => patchDraft(set, get, { preference }),

  setVersionsPerImage: (versionsPerImage) => patchDraft(set, get, { versionsPerImage }),

  swapBackground: async () => {
    const { draft, selectedImageId, swapStage } = get()
    const image = draft.images.find((item) => item.imageId === selectedImageId)
    const jobId = draft.id
    if (swapStage || !image || !jobId) return

    await runStages(set, 'plan', async () => {
      const dataUrl = await loadOriginal(image.imageId)
      const plan = await requestBackgroundPlan({ image: dataUrl, preference: draft.preference })
      await runVersion(set, get, {
        jobId,
        imageId: image.imageId,
        dataUrl,
        versionId: crypto.randomUUID(),
        plan: plan.plan,
        prompt: plan.prompt,
      })
    })
  },

  /** 重跑沿用这一版已有的方案与提示词，只换掉任务，版本条上不多出一条。 */
  retryVersion: async (versionId) => {
    const { draft, swapStage } = get()
    const image = draft.images.find((item) =>
      item.versions.some((version) => version.id === versionId),
    )
    const version = image?.versions.find((item) => item.id === versionId)
    const jobId = draft.id
    if (swapStage || !image || !version || !jobId) return

    await runStages(set, 'matte', async () => {
      await runVersion(set, get, {
        jobId,
        imageId: image.imageId,
        dataUrl: await loadOriginal(image.imageId),
        versionId,
        plan: version.plan,
        prompt: version.prompt,
      })
    })
  },

  chooseVersion: (versionId) => {
    set((s) => ({
      draft: {
        ...s.draft,
        images: s.draft.images.map((image) =>
          image.imageId === s.selectedImageId ? { ...image, chosenVersionId: versionId } : image,
        ),
      },
    }))
    void persistDraft(set, get)
  },

  previewVersion: (previewVersionId) => set({ previewVersionId }),
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

async function loadOriginal(imageId: string): Promise<string> {
  const dataUrl = await ensureImageCached(imageId)
  if (!dataUrl) throw new Error('原图已不在本地')
  return dataUrl
}

interface VersionSeed {
  jobId: string
  imageId: string
  dataUrl: string
  versionId: string
  plan: string
  prompt: string
}

/** 读秒的开关与失败说明只在这里写，出一版与重跑一版进来的段位不同。 */
async function runStages(
  set: SetState,
  first: BgSwapStage,
  body: () => Promise<void>,
): Promise<void> {
  set({ swapStage: first, swapStartedAt: Date.now(), swapNotice: null })
  try {
    await body()
  } catch (error) {
    set({ swapNotice: reasonOf(error) })
  } finally {
    set({ swapStage: null, swapStartedAt: null })
  }
}

/** 蒙版 → 提交 → 回写，出一版与重跑一版共用；调用方负责方案与收尾。 */
async function runVersion(set: SetState, get: GetState, seed: VersionSeed): Promise<void> {
  set({ swapStage: 'matte' })
  const mask = await buildMask(set, seed.imageId, seed.dataUrl)

  set({ swapStage: 'generate' })
  const [taskId] = await submitPrepared({
    prompt: seed.prompt,
    inputImages: [{ id: seed.imageId, dataUrl: seed.dataUrl }],
    params: { ...useStore.getState().params, n: 1 },
    mask,
    origin: { setId: seed.jobId, shotId: `${seed.imageId}:${seed.versionId}` },
  })
  // 提交门禁拦下时没有任务 id，submitPrepared 已经解释过原因，这里不留空版本。
  if (!taskId) return

  const version: BgSwapVersion = {
    id: seed.versionId,
    taskId,
    plan: seed.plan,
    prompt: seed.prompt,
    masked: mask !== null,
    createdAt: Date.now(),
  }
  set((s) => ({
    draft: {
      ...s.draft,
      images: s.draft.images.map((image) =>
        image.imageId === seed.imageId
          ? { ...image, versions: upsertVersion(image.versions, version) }
          : image,
      ),
    },
    previewVersionId: version.id,
  }))
  await persistDraft(set, get)
}

function upsertVersion(versions: BgSwapVersion[], version: BgSwapVersion): BgSwapVersion[] {
  return versions.some((item) => item.id === version.id)
    ? versions.map((item) => (item.id === version.id ? version : item))
    : [...versions, version]
}

/** 抠不出来就回落提示词版：宁可产品不锁死，也不要卡住这一版。 */
async function buildMask(set: SetState, imageId: string, dataUrl: string): Promise<Mask | null> {
  if (
    !modelSupportsNativeMask(getActiveApiProfile(useStore.getState().settings), getPublicChannels())
  ) {
    set({ swapNotice: MASK_UNSUPPORTED })
    return null
  }
  try {
    const matte = await segmentProduct(dataUrl)
    if (!assessMatte(matte).ok) {
      set({ swapNotice: MATTE_FAILED })
      return null
    }
    return { imageId: await storeImage(alphaToInpaintMask(matte), 'mask'), targetImageId: imageId }
  } catch {
    set({ swapNotice: MATTE_FAILED })
    return null
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
