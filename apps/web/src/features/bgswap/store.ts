import { create } from 'zustand'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { fetchListingImages, listingImageProxyUrl } from '../../lib/listingClient'
import { storeImageFromFile, storeImageFromUrl, useStore } from '../../store'
import { bgSwapJobStore } from './lib/bgSwapJobStore'
import type { BgSwapImage, BgSwapJobRecord } from './types'

const UPLOAD_FALLBACK = '请直接上传原图'

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

  loadJobs: () => Promise<void>
  startNewJob: () => void
  selectJob: (id: string) => void

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
      const reason = error instanceof Error ? error.message : String(error)
      set({ listingNotice: `${reason}，${UPLOAD_FALLBACK}` })
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
        const reason = error instanceof Error ? error.message : String(error)
        useStore.getState().showToast(`图片添加失败：${reason}`, 'error')
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

  selectImage: (selectedImageId) => set({ selectedImageId }),

  setPreference: (preference) => patchDraft(set, get, { preference }),

  setVersionsPerImage: (versionsPerImage) => patchDraft(set, get, { versionsPerImage }),
}))

type SetState = (partial: Partial<BgSwapState> | ((s: BgSwapState) => Partial<BgSwapState>)) => void
type GetState = () => BgSwapState

function patchDraft(set: SetState, get: GetState, patch: Partial<BgSwapDraft>): void {
  set((s) => ({ draft: { ...s.draft, ...patch } }))
  void persistDraft(set, get)
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
