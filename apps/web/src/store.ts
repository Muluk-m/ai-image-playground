import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  clientProfileToApiProfile,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  getCustomProviderDefinition,
  mergeImportedSettings,
  normalizeSettings,
  validateClientProfile,
} from './lib/apiProfiles'
import {
  getModelCapabilities,
  modelSupportsEdit,
  NO_EDIT_SUPPORT_MESSAGE,
} from './lib/channels/profileSelectors'
import { getPublicChannels } from './lib/channels/publicChannels'
import type { ClientProfile } from './lib/channels/types'
import type {
  AppSettings,
  ExportData,
  InputImage,
  MaskDraft,
  TaskParams,
  TaskRecord,
} from './types'
import { DEFAULT_PARAMS } from './types'

function filterUserProfileCache(
  cache: Record<string, string[]>,
  profiles: ClientProfile[],
): Record<string, string[]> {
  const builtinIds = new Set(profiles.filter((p) => p.source === 'builtin-edge').map((p) => p.id))
  return Object.fromEntries(Object.entries(cache).filter(([id]) => !builtinIds.has(id)))
}

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { callImageApi, resumeQueueImageApi } from './lib/api'
import { STORE_PERSIST_KEY, scopedLocalStorage } from './lib/authScope'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { isByokGenerationEnabled, isClientCapabilityEnabled } from './lib/clientCapabilities'
import { compressInputImageDataUrls } from './lib/compressInputImage'
import {
  CURRENT_THUMBNAIL_VERSION,
  clearImages,
  clearTasks as dbClearTasks,
  deleteTask as dbDeleteTask,
  deleteImage,
  getAllImageIds,
  getAllImages,
  getAllTasks,
  getImage,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
  putImage,
  putImageThumbnail,
  putTask,
  storeImage,
} from './lib/db'
import { IMAGE_FETCH_CORS_HINT, bytesToDataUrl as sharedBytesToDataUrl } from './lib/imageApiShared'
import { orderInputImagesForMask } from './lib/mask'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import {
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from './lib/privateOverlay'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  expandPromptSlots,
  getSubmissionImageCount,
  getUnfilledPromptSlots,
  MAX_BATCH_IMAGES,
  type SlotValues,
} from './lib/promptSlots'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import {
  createTransparentOutputMeta,
  getTransparentRequestParams,
  removeKeyedBackgroundFromDataUrl,
} from './lib/transparentImage'

// ===== Image cache =====
// 内存缓存，id → dataUrl。只保留少量最近使用图片，避免大量 4K data URL 常驻内存。

const imageCache = new Map<string, string>()
const thumbnailCache = new Map<
  string,
  { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }
>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailSubscribers = new Map<
  string,
  Set<(thumbnail: { dataUrl: string; width?: number; height?: number }) => void>
>()
let thumbnailBackfillScheduled = false
const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4
const CUSTOM_RECOVERY_POLL_MS = 10_000
/** submitTask 后若用户已滚出此高度（px），把视口平滑滚回顶部把新卡片带进视野。 */
const SUBMIT_SCROLL_TO_TOP_THRESHOLD_PX = 80
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const OPENAI_INTERRUPTED_ERROR = '请求中断'

function createOpenAITimeoutError(timeoutSeconds: number) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`
}

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

function cacheImage(id: string, dataUrl: string) {
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

interface StoredGeneratedImagesResult {
  outputIds: string[]
  outputDataUrls: string[]
  transparentOriginalImageIds?: string[]
}

/** 生成成功路径共用：输出图逐张写 image store 并回填内存缓存。 */
async function storeGeneratedImages(
  images: string[],
  task?: Pick<TaskRecord, 'transparentOutput'>,
): Promise<StoredGeneratedImagesResult> {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const transparentOriginalImageIds: string[] = []

  for (const dataUrl of images) {
    let outputDataUrl = dataUrl

    if (task?.transparentOutput) {
      const originalId = await storeImage(dataUrl, 'generated')
      cacheImage(originalId, dataUrl)
      try {
        outputDataUrl = await removeKeyedBackgroundFromDataUrl(dataUrl)
        transparentOriginalImageIds.push(originalId)
      } catch (err) {
        console.warn('透明背景后处理失败，已回退为原始输出', err)
        outputIds.push(originalId)
        outputDataUrls.push(dataUrl)
        transparentOriginalImageIds.push('')
        continue
      }
    }

    const imgId = await storeImage(outputDataUrl, 'generated')
    cacheImage(imgId, outputDataUrl)
    outputIds.push(imgId)
    outputDataUrls.push(outputDataUrl)
  }

  return {
    outputIds,
    outputDataUrls,
    transparentOriginalImageIds: transparentOriginalImageIds.length
      ? transparentOriginalImageIds
      : undefined,
  }
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) {
    thumbnailCache.delete(id)
  }
  return undefined
}

function cacheThumbnail(
  id: string,
  thumbnail: { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number },
) {
  if (thumbnail.thumbnailVersion !== CURRENT_THUMBNAIL_VERSION) return
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
  }
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const cached = getCachedImage(id)
  if (cached) return cached
  const rec = await getImage(id)
  if (rec) {
    cacheImage(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

export async function ensureImageThumbnailCached(
  id: string,
): Promise<{ dataUrl: string; width?: number; height?: number } | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) {
    scheduleThumbnailBackfill([id], 'visible')
    return undefined
  }

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: rec.width,
    height: rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export function subscribeImageThumbnail(
  id: string,
  callback: (thumbnail: { dataUrl: string; width?: number; height?: number }) => void,
) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

function notifyImageThumbnail(
  id: string,
  thumbnail: { dataUrl: string; width?: number; height?: number },
) {
  thumbnailSubscribers.get(id)?.forEach((callback) => callback(thumbnail))
}

function scheduleThumbnailBackfill(
  ids: Iterable<string>,
  priority: 'visible' | 'background' = 'background',
) {
  for (const id of ids) {
    if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) continue
    const currentPriority = thumbnailBackfillIds.get(id)
    if (!currentPriority || priority === 'visible') thumbnailBackfillIds.set(id, priority)
  }
  scheduleThumbnailBackfillTick()
}

function scheduleThumbnailBackfillTick() {
  if (thumbnailBackfillScheduled || thumbnailBackfillIds.size === 0) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    globalThis.setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  if (thumbnailBackfillRunningIds.size > 0) return

  const ids = await getNextThumbnailBackfillBatch()
  for (const id of ids) startThumbnailBackfill(id)

  if (thumbnailBackfillIds.size > 0) scheduleThumbnailBackfillTick()
}

async function getNextThumbnailBackfillBatch() {
  const candidates = getOrderedThumbnailBackfillIds().slice(0, MAX_THUMBNAIL_BACKFILL_CONCURRENT)
  if (candidates.length === 0) return []

  const sizes = await Promise.all(
    candidates.map(async (id) => {
      const image = await getImage(id)
      return { width: image?.width, height: image?.height }
    }),
  )
  const concurrency = getThumbnailConcurrencyForBatch(sizes)
  const selected = candidates.slice(0, concurrency)
  for (const id of selected) thumbnailBackfillIds.delete(id)
  return selected
}

function getOrderedThumbnailBackfillIds() {
  const visible: string[] = []
  const background: string[] = []
  for (const [id, priority] of thumbnailBackfillIds) {
    if (priority === 'visible') visible.push(id)
    else background.push(id)
  }
  return [...visible, ...background]
}

function getThumbnailConcurrencyForBatch(sizes: Array<{ width?: number; height?: number }>) {
  let maxMegapixels = 0
  for (const { width, height } of sizes) {
    if (!width || !height) return 1
    maxMegapixels = Math.max(maxMegapixels, (width * height) / 1_000_000)
  }
  const megapixels = maxMegapixels
  if (megapixels >= 8) return 1
  if (megapixels >= 4) return 2
  if (megapixels >= 2) return 3
  return 4
}

function startThumbnailBackfill(id: string) {
  thumbnailBackfillRunningIds.add(id)

  void (async () => {
    if (getCachedThumbnail(id)) return

    const thumbnail = await getImageThumbnail(id)
    if (thumbnail?.thumbnailDataUrl) {
      cacheThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: thumbnail.thumbnailVersion,
      })
      notifyImageThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      })
    }
  })()
    .catch(() => {
      // Keep thumbnail generation best-effort; cards remain on placeholders if it fails.
    })
    .finally(() => {
      thumbnailBackfillRunningIds.delete(id)
      scheduleThumbnailBackfillTick()
    })
}

function orderImagesWithMaskFirst(
  images: InputImage[],
  maskTargetImageId: string | null | undefined,
) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

export function getPersistedState(state: AppState) {
  const normalized = normalizeSettings(state.settings)
  // builtin-edge profile 不进 localStorage：其完整定义来自 config/channels.json + edge env。
  // 只持久化 user-byok profile + 用户对 builtin-edge 的 selectedModelId 选择。
  const settings: AppSettings = {
    ...normalized,
    profiles: normalized.profiles.filter((p) => p.source !== 'builtin-edge'),
  }
  return {
    settings,
    params: state.params,
    ...(settings.persistInputOnRestart
      ? {
          prompt: state.prompt,
          slotValues: state.slotValues,
          inputImages: state.inputImages.map((img) => ({ id: img.id, dataUrl: '' })),
        }
      : {}),
    appMode: state.appMode,
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    inspirationCoachDismissed: state.inspirationCoachDismissed,
    pinnedInspirationIds: state.pinnedInspirationIds,
    // 内置 channel 的 model cache 不进 localStorage（避免敏感模型清单泄漏到导出）。
    // 通过 profile.source === 'builtin-edge' 判定，而不是字符串前缀。
    profileModelCache: filterUserProfileCache(state.profileModelCache ?? {}, settings.profiles),
  }
}

function normalizeSlotValues(persisted: unknown): SlotValues {
  if (!persisted || typeof persisted !== 'object') return {}
  return Object.fromEntries(
    Object.entries(persisted).flatMap(([name, values]) =>
      Array.isArray(values)
        ? [[name, values.filter((v): v is string => typeof v === 'string')]]
        : [],
    ),
  )
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  if (!persistedState || typeof persistedState !== 'object') return currentState

  const persisted = persistedState as Partial<AppState>
  const settings = normalizeSettings(persisted.settings ?? currentState.settings)
  return {
    ...currentState,
    ...persisted,
    settings,
    // 旧版本持久化的 params 可能缺新增字段，与 DEFAULT_PARAMS 合并补齐
    params: { ...DEFAULT_PARAMS, ...persisted.params },
    inspirationCoachDismissed: Boolean(persisted.inspirationCoachDismissed),
    pinnedInspirationIds: Array.isArray(persisted.pinnedInspirationIds)
      ? persisted.pinnedInspirationIds.filter((x): x is string => typeof x === 'string')
      : [],
    prompt:
      settings.persistInputOnRestart && typeof persisted.prompt === 'string'
        ? persisted.prompt
        : '',
    inputImages:
      settings.persistInputOnRestart && Array.isArray(persisted.inputImages)
        ? persisted.inputImages
        : [],
    slotValues: settings.persistInputOnRestart ? normalizeSlotValues(persisted.slotValues) : {},
  }
}

// ===== Store 类型 =====

interface AppState {
  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  slotValues: SlotValues
  setSlotValues: (name: string, values: string[]) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (
    imgs: InputImage[],
    options?: { equivalentImageIds?: Record<string, string> },
  ) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (
    profileId: string | null,
    missing?: boolean,
    profileName?: string | null,
  ) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  /** 顶层视图模式：browse = 历史任务网格；create = 无限画布创作模式 */
  appMode: 'browse' | 'create'
  setAppMode: (mode: AppState['appMode']) => void
  /**
   * 「工作台图片 → 创作模式画布」一次性 handoff 队列（不持久化）：browse 卡片点「送入画布」
   * 时暂存待放入的 dataUrl，切到 create 后由画布 onMount 消费。是内存传递，跨刷新不复现。
   */
  pendingCanvasImages: string[]
  queueCanvasImages: (dataUrls: string[]) => void
  consumeCanvasImages: () => string[]
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void
  /** 按 profile.id 缓存上游 /models 拉取结果，仅用户 profile 持久化 */
  profileModelCache: Record<string, string[]>
  setProfileModelCache: (profileId: string, models: string[]) => void
  /** 新人引导：第一次访问、还没生成过图时在 Header 灵感库按钮上引出气泡。 */
  inspirationCoachDismissed: boolean
  dismissInspirationCoach: () => void
  /** 用户手动置顶的灵感 id 列表；顺序 = pin 顺序（最近 pin 的在前）。 */
  pinnedInspirationIds: string[]
  /** toggle 置顶状态：未 pin → pin（插到最前）；已 pin → unpin。 */
  toggleInspirationPin: (id: string) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) =>
        set((st) => {
          const settings = normalizeSettings({ ...st.settings, ...s })
          const shouldClearReusedProfile =
            st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
          return {
            settings,
            ...(shouldClearReusedProfile
              ? {
                  reusedTaskApiProfileId: null,
                  reusedTaskApiProfileName: null,
                  reusedTaskApiProfileMissing: false,
                }
              : {}),
          }
        }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) =>
        set((st) => ({
          dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
            ? st.dismissedCodexCliPrompts
            : [...st.dismissedCodexCliPrompts, key],
        })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      slotValues: {},
      setSlotValues: (name, values) =>
        set((s) => ({ slotValues: { ...s.slotValues, [name]: values } })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return {
            inputImages: [],
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          }
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) &&
            !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages,
            prompt: remapImageMentionsForOrder(
              s.prompt,
              s.inputImages,
              inputImages,
              options?.equivalentImageIds,
            ),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx =
            maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return {
            inputImages: images,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, images),
          }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          }
        }),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set({ maskEditorImageId })
      },

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) =>
        set({
          reusedTaskApiProfileId: profileId,
          reusedTaskApiProfileName: profileName,
          reusedTaskApiProfileMissing: missing,
        }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({ tasks })),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) =>
        set((s) => ({
          selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater,
        })),
      toggleTaskSelection: (id, force) =>
        set((s) => {
          const isSelected = s.selectedTaskIds.includes(id)
          const shouldSelect = force !== undefined ? force : !isSelected
          if (shouldSelect === isSelected) return s
          return {
            selectedTaskIds: shouldSelect
              ? [...s.selectedTaskIds, id]
              : s.selectedTaskIds.filter((x) => x !== id),
          }
        }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({
          lightboxImageId,
          lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []),
        })
      },
      appMode: 'browse',
      setAppMode: (appMode) => set({ appMode }),
      pendingCanvasImages: [],
      queueCanvasImages: (dataUrls) =>
        set((s) => ({ pendingCanvasImages: [...s.pendingCanvasImages, ...dataUrls] })),
      consumeCanvasImages: () => {
        const pending = get().pendingCanvasImages
        if (pending.length > 0) set({ pendingCanvasImages: [] })
        return pending
      },
      showSettings: false,
      setShowSettings: (showSettings) => {
        if (showSettings) dismissAllTooltips()
        set({ showSettings })
      },
      profileModelCache: {},
      setProfileModelCache: (profileId, models) =>
        set((st) => ({
          profileModelCache: { ...st.profileModelCache, [profileId]: models },
        })),
      inspirationCoachDismissed: false,
      dismissInspirationCoach: () => set({ inspirationCoachDismissed: true }),
      pinnedInspirationIds: [],
      toggleInspirationPin: (id) =>
        set((st) => {
          const exists = st.pinnedInspirationIds.includes(id)
          return {
            pinnedInspirationIds: exists
              ? st.pinnedInspirationIds.filter((x) => x !== id)
              : [id, ...st.pinnedInspirationIds],
          }
        }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: STORE_PERSIST_KEY,
      storage: createJSONStorage(() => scopedLocalStorage),
      version: 1,
      // v0 → v1：防改写默认值翻转为开启。v0 里 no_rewrite=false 是只上线过数小时的
      // 旧默认值而非用户主动选择，一次性抬升为 true；之后的显式关闭会随 v1 持久化保留。
      migrate: (persisted) => {
        const p = persisted as { params?: TaskParams } | null
        if (p?.params) p.params = { ...p.params, no_rewrite: true }
        return p
      },
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const view = clientProfileToApiProfile(getActiveApiProfile(settings))
  return `${view.baseUrl}\n${view.apiKey}`
}

function isOpenAITask(_task: TaskRecord) {
  return true
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && isOpenAITask(task)
}

function isAsyncCustomProviderTask(
  settings: AppSettings,
  provider: string,
  hasInputImages: boolean,
) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping =
    hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now = Date.now()) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    // 已有 request_id（customTaskId / bffRequestId）→ initStore 走恢复轮询，
    // 有 clientRequestId → 走重提交（BFF 去重）。都不当中断。
    if (
      !isRunningOpenAITask(task) ||
      task.customTaskId ||
      task.bffRequestId ||
      task.clientRequestId
    ) {
      return task
    }

    const updated: TaskRecord = {
      ...task,
      status: 'error',
      error: OPENAI_INTERRUPTED_ERROR,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

export function showCodexCliPrompt(reason: string) {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。提示词防改写由输入栏参数中的「防改写」开关控制（默认开启）。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      const current = normalizeSettings(state.settings)
      const profiles = current.profiles.map((p) =>
        p.id === current.activeProfileId && p.source === 'user-byok'
          ? { ...p, preferences: { ...p.preferences, codexCli: true } }
          : p,
      )
      state.setSettings({ profiles })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord): ClientProfile | null {
  const provider = task.apiProvider
  if (!provider || provider === 'openai') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile && clientProfileToApiProfile(taskProfile).provider === provider)
    return taskProfile

  const normalized = normalizeSettings(settings)
  const active = getActiveApiProfile(normalized)
  if (clientProfileToApiProfile(active).provider === provider) return active
  const profilesWithView = normalized.profiles.map((p) => ({ p, v: clientProfileToApiProfile(p) }))
  return (
    profilesWithView.find(
      ({ v }) =>
        v.provider === provider && (v.name === task.apiProfileName || v.model === task.apiModel),
    )?.p ??
    profilesWithView.find(({ v }) => v.provider === provider)?.p ??
    null
  )
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ClientProfile | null {
  const normalized = normalizeSettings(settings)
  const provider = task.apiProvider
  const profilesWithView = normalized.profiles.map((p) => ({ p, v: clientProfileToApiProfile(p) }))

  if (task.apiProfileId) {
    const byId = profilesWithView.find(({ p }) => p.id === task.apiProfileId)
    if (byId && (!provider || byId.v.provider === provider)) return byId.p
    return null
  }

  if (!provider) return null

  const candidates = profilesWithView.filter(({ v }) => v.provider === provider)
  if (!candidates.length) return null

  if (task.apiProfileName) {
    const byName = candidates.find(({ v }) => v.name === task.apiProfileName)
    if (byName) return byName.p
  }

  if (task.apiModel) {
    const modelMatches = candidates.filter(({ v }) => v.model === task.apiModel)
    if (modelMatches.length === 1) return modelMatches[0].p
  }

  return candidates.length === 1 ? candidates[0].p : null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ClientProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  const found = normalized.profiles.some((item) => item.id === profile.id)
  const nextProfiles = found
    ? normalized.profiles.map((item) => (item.id === profile.id ? profile : item))
    : [...normalized.profiles, profile]
  return normalizeSettings({
    ...normalized,
    profiles: nextProfiles,
    activeProfileId: profile.id,
  })
}

function getReusedTaskApiProfile(
  settings: AppSettings,
  profileId: string | null,
): ClientProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isConnectionRecoverableError(err: unknown) {
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  )
    return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(
    message,
  )
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(
      message,
    )
  }
  return false
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  task: TaskRecord,
  settings: AppSettings,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const profile = getTaskApiProfile(settings, task)
  const elapsedSeconds = Math.max(0, (Date.now() - task.createdAt) / 1000)
  const profileView = profile ? clientProfileToApiProfile(profile) : null
  const usesApiProxy =
    profileView?.apiProxy ?? clientProfileToApiProfile(getActiveApiProfile(settings)).apiProxy

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    return '提示：接口可能不支持浏览器跨域请求，可开启 API 代理解决。'
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return '提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。'
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return '提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。'
  }

  return '提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。'
}

function getRawErrorPayload(
  err: unknown,
): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls =
    'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload =
    'rawResponsePayload' in err
      ? (err as { rawResponsePayload?: unknown }).rawResponsePayload
      : undefined
  return {
    rawImageUrls:
      Array.isArray(rawImageUrls) && rawImageUrls.length
        ? rawImageUrls.filter((url): url is string => typeof url === 'string')
        : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

function hasActualParams(params: Partial<TaskParams> | undefined): params is Partial<TaskParams> {
  return Boolean(params && Object.keys(params).length > 0)
}

function firstActualParams(
  paramsList: Array<Partial<TaskParams> | undefined> | undefined,
): Partial<TaskParams> | undefined {
  return paramsList?.find(hasActualParams)
}

function mapActualParamsByImage(
  outputIds: string[],
  paramsList: Array<Partial<TaskParams> | undefined> | undefined,
) {
  const mapped = paramsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && hasActualParams(params)) acc[imgId] = params
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(
  images: string[],
): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  if (preferred?.length === images.length && preferred.every(hasActualParams)) return preferred
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) =>
    hasActualParams(preferred?.[index]) ? preferred?.[index] : fallback[index],
  )
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const storedTasks = await getAllTasks()
  const { tasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks)
  await Promise.all(interruptedTasks.map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  for (const task of tasks) {
    if (task.customTaskId && (task.status === 'running' || task.customRecoverable)) {
      scheduleCustomRecovery(task.id, 0)
    }
    // BFF queue 任务：仍在 running 且持有 request_id → 重新接管轮询。
    // markInterruptedOpenAIRunningTasks 已经放行这类 task，所以这里
    // 看到的 status 还是 'running'。
    if (task.bffRequestId && task.status === 'running') {
      executeTask(task.id)
      continue
    }
    // 提交期间页面刷新：task 已落盘但 submit 还没返回 request_id。
    // 用 clientRequestId 重提交，BFF 端去重，不会重复消耗上游配额。
    if (task.clientRequestId && !task.customTaskId && task.status === 'running') {
      executeTask(task.id)
    }
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const persistedInputImages = useStore.getState().inputImages
  for (const img of persistedInputImages) referencedIds.add(img.id)
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) {
      referencedIds.add(id)
    }
    for (const id of t.transparentOriginalImages || []) {
      if (id) referencedIds.add(id)
    }
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (
    restoredInputImages.length !== persistedInputImages.length ||
    restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)
  ) {
    useStore.getState().setInputImages(restoredInputImages)
  }
}

/** 提交新任务 */
export async function submitTask(
  options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean } = {},
) {
  const {
    settings,
    prompt,
    slotValues,
    inputImages,
    maskDraft,
    params,
    reusedTaskApiProfileId,
    reusedTaskApiProfileName,
    reusedTaskApiProfileMissing,
    showToast,
    setConfirmDialog,
  } = useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getActiveApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (
    normalizedSettings.reuseTaskApiProfileTemporarily &&
    (reusedTaskApiProfileId || reusedTaskApiProfileMissing)
  ) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
          message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${clientProfileToApiProfile(activeProfile).name}」提交任务吗？`,
          confirmText: '使用当前配置提交',
          cancelText: '放弃提交',
          action: () => {
            void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
          },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  if (!isByokGenerationEnabled() && activeProfile.source !== 'builtin-edge') {
    showToast('当前部署只允许使用内置模型', 'error')
    return
  }

  const validationError = validateClientProfile(activeProfile)
  if (validationError) {
    showToast(`请先完善请求 API 配置：${validationError}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  const unfilledSlots = getUnfilledPromptSlots(prompt, slotValues)
  if (unfilledSlots.length > 0) {
    showToast(`槽位 {${unfilledSlots[0]}} 未填值`, 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(
        maskDraft.maskDataUrl,
        orderedInputImages[0].dataUrl,
      )
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, {
    hasInputImages: orderedInputImages.length > 0,
  })
  const shouldUseTransparentOutput =
    normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const submitView = clientProfileToApiProfile(activeProfile)
  // Billed submissions must stay in one BFF task so credit reservation is atomic. Otherwise,
  // only channels that explicitly declare native count support receive n in one request.
  const billedBuiltinSubmission =
    activeProfile.source === 'builtin-edge' && isClientCapabilityEnabled('billing:credits')
  const supportsNativeCount =
    getModelCapabilities(activeProfile, getPublicChannels())?.has('n') === true
  const fanOut = billedBuiltinSubmission || supportsNativeCount ? 1 : Math.max(1, taskParams.n)
  const singleParams = fanOut === 1 ? taskParams : { ...taskParams, n: 1 }
  const trimmedPrompt = prompt.trim()
  if (getSubmissionImageCount(trimmedPrompt, slotValues, taskParams.n) > MAX_BATCH_IMAGES) {
    showToast(`单次最多 ${MAX_BATCH_IMAGES} 张`, 'error')
    return
  }
  const createdAt = Date.now()
  const newTasks: TaskRecord[] = expandPromptSlots(trimmedPrompt, slotValues).flatMap(
    (taskPrompt) => {
      const transparentMeta = taskParams.transparent_output
        ? createTransparentOutputMeta(taskPrompt)
        : null
      return Array.from({ length: fanOut }, () => ({
        id: genId(),
        prompt: taskPrompt,
        params: singleParams,
        apiProvider: submitView.provider,
        apiProfileId: activeProfile.id,
        apiProfileName: submitView.name,
        apiModel: submitView.model,
        inputImageIds: orderedInputImages.map((i) => i.id),
        maskTargetImageId,
        maskImageId,
        transparentOutput: transparentMeta?.transparentOutput,
        transparentPrompt: transparentMeta?.effectivePrompt,
        outputImages: [],
        status: 'running' as const,
        error: null,
        createdAt,
        finishedAt: null,
        elapsed: null,
        clientRequestId: crypto.randomUUID(),
      }))
    },
  )

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([...newTasks, ...latestTasks])
  await Promise.all(newTasks.map((t) => putTask(t)))

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  // 滚出顶部时把视口平滑滚回，让新卡片即刻可见。已在顶部时无需动。
  if (typeof window !== 'undefined' && window.scrollY > SUBMIT_SCROLL_TO_TOP_THRESHOLD_PX) {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  for (const t of newTasks) {
    void executeTask(t.id)
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: '找不到此任务所使用的 API 配置。',
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    return
  }
  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const activeView = clientProfileToApiProfile(activeProfile)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = task.apiProvider ?? activeView.provider
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  // 刷新页面后恢复 BFF queue 任务：跳过 submit / 输入图片加载 / OpenAI watchdog，
  // 用持久化的 bffRequestId 直接 poll → fetchResult。BFF 自己有 30 min 轮询硬上限。
  const isResume = task.status === 'running' && Boolean(task.bffRequestId)

  // builtin-edge queue 路径由 queueClient.ts 的 POLL_MAX_MS (30 min) 兜底超时，
  // 不走 watchdog；否则 BFF 端 retry（Bun socket idle ~300s × 2 + backoff > 600s）
  // 会被 watchdog 提前在前端单方面标 failed，BFF 还在后台继续跑。
  if (
    !isResume &&
    activeProfile.source !== 'builtin-edge' &&
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0)
  ) {
    scheduleOpenAIWatchdog(taskId, activeView.timeout)
  }

  try {
    let result
    let maskDataUrl: string | undefined
    if (isResume) {
      result = await resumeQueueImageApi(
        {
          settings: requestSettings,
          prompt: task.prompt,
          params: task.params,
          inputImageDataUrls: [],
        },
        task.bffRequestId!,
      )
    } else {
      // 获取输入图片 data URLs
      const inputDataUrls: string[] = []
      for (const imgId of task.inputImageIds) {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        inputDataUrls.push(dataUrl)
      }
      if (task.maskImageId) {
        maskDataUrl = await ensureImageCached(task.maskImageId)
        if (!maskDataUrl) throw new Error('遮罩图片已不存在')
      }

      const requestPrompt =
        task.transparentOutput && task.transparentPrompt ? task.transparentPrompt : task.prompt

      result = await callImageApi({
        settings: requestSettings,
        prompt: replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
        params: task.params,
        inputImageDataUrls: inputDataUrls,
        maskDataUrl,
        clientRequestId: task.clientRequestId,
        onCustomTaskEnqueued: (request) => {
          customTaskInfo = request
          updateTaskInStore(taskId, {
            customTaskId: request.taskId,
            customRecoverable: false,
          })
        },
        onQueueSubmitted: (requestId) => {
          updateTaskInStore(taskId, { bffRequestId: requestId })
          notifyPrivateSubmissionAccepted()
        },
      })
    }

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') return

    // 存储输出图片
    const { outputIds, outputDataUrls, transparentOriginalImageIds } = await storeGeneratedImages(
      result.images,
      task,
    )
    const isAsyncCustomTask = taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = isAsyncCustomTask
      ? await readImageSizeParamsList(outputDataUrls)
      : result.actualParamsList
    const actualParams = (() => {
      if (isAsyncCustomTask) return firstActualParams(actualParamsList)
      return { ...result.actualParams, n: outputIds.length }
    })()
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPromptByImage = isAsyncCustomTask
      ? undefined
      : result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
          const imgId = outputIds[index]
          if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
          return acc
        }, {})

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') return
    clearOpenAIWatchdogTimer(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage:
        revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0
          ? revisedPromptByImage
          : undefined,
      status: 'done',
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
      customRecoverable: false,
    })

    useStore.getState().showToast(`生成完成，共 ${outputIds.length} 张图片`, 'success')
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    notifyPrivateSubmissionError(err)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId) ?? task
    if (latestTask.status !== 'running') return
    const latestCustomTaskInfo =
      customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestCustomTaskInfo && isConnectionRecoverableError(err)) {
      updateTaskInStore(taskId, {
        status: 'error',
        error: '与自定义异步任务的连接已断开，之后会继续查询任务结果。',
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const networkErrorHint = getApiRequestNetworkErrorHint(
        err,
        latestTask,
        useStore.getState().settings,
      )
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        status: 'error',
        error: errorMessage,
        ...getRawErrorPayload(err),
        customRecoverable: false,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    notifyPrivateSubmissionSettled()
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      imageCache.delete(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t))
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const { settings } = useStore.getState()
  const activeProfile = getActiveApiProfile(settings)
  const activeView = clientProfileToApiProfile(activeProfile)
  const normalizedParams = normalizeParamsForSettings(task.params, settings, {
    hasInputImages: task.inputImageIds.length > 0,
  })
  const shouldUseTransparentOutput =
    normalizedParams.output_format === 'png' && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(task.prompt.trim())
    : null
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: taskParams,
    apiProvider: activeView.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeView.name,
    apiModel: activeView.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const {
    settings,
    setPrompt,
    setParams,
    setInputImages,
    setMaskDraft,
    clearMaskDraft,
    showToast,
    setConfirmDialog,
    setReusedTaskApiProfile,
  } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const currentView = clientProfileToApiProfile(currentProfile)
  const matchedProfile = normalizedSettings.reuseTaskApiProfileTemporarily
    ? getTaskApiProfile(normalizedSettings, task)
    : null
  const matchedView = matchedProfile ? clientProfileToApiProfile(matchedProfile) : null
  const shouldTemporarilyReuseProfile = Boolean(
    matchedProfile && matchedProfile.id !== currentProfile.id,
  )
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedView?.name ?? getTaskApiProfileName(task)
  const paramsSettings =
    shouldTemporarilyReuseProfile && matchedProfile
      ? createSettingsForApiProfile(normalizedSettings, matchedProfile)
      : normalizedSettings

  setParams(
    normalizeParamsForSettings(task.params, paramsSettings, {
      hasInputImages: task.inputImageIds.length > 0,
    }),
  )
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId =
    task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentView.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedView
      ? `已临时复用该任务的 API 配置「${matchedView.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/**
 * 对任务的某张输出图开启遮罩编辑（局部重绘）：先确保该图在参考图框里
 * （遮罩编辑器保存时按 inputImages 替换 target，不在框里遮罩会丢），
 * 再打开遮罩编辑器。不传 imageId 时默认取首张输出图。
 */
export async function editOutputImage(task: TaskRecord, imageId?: string) {
  const { inputImages, addInputImage, setMaskEditorImageId, showToast, settings } =
    useStore.getState()
  const targetId = imageId ?? task.outputImages?.[0]
  if (!targetId) return

  if (!modelSupportsEdit(getActiveApiProfile(settings), getPublicChannels())) {
    showToast(NO_EDIT_SUPPORT_MESSAGE, 'error')
    return
  }

  const dataUrl = await ensureImageCached(targetId)
  if (!dataUrl) {
    showToast('图片已不存在，无法编辑', 'error')
    return
  }
  if (!inputImages.find((i) => i.id === targetId)) {
    addInputImage({ id: targetId, dataUrl })
  }
  setMaskEditorImageId(targetId)
}

/** 画布任务发起时快照的 profile 身份（落历史保真，避免完成时用户已切 profile 而失真）。 */
export type CanvasProfileSnapshot = Pick<
  TaskRecord,
  'apiProvider' | 'apiProfileId' | 'apiProfileName' | 'apiModel'
>

/**
 * 画布生成完成后落一条已完成任务进工作台历史：输出图写 image store，可收藏 / 检索 /
 * 下载 / 复用 prompt，与工作台任务同列展示。画布任务的输入图是选区栅格化的临时合成物，
 * 刻意不落库（inputImageIds 恒空）。历史写入是 best-effort：失败仅告警，不抛、不影响画布结果。
 * profile 身份优先用发起时快照（缺失兜底当前 active profile，如旧占位框恢复）。
 */
export async function addCompletedCanvasTask(args: {
  prompt: string
  params: TaskParams
  images: string[]
  elapsed?: number
  profile?: CanvasProfileSnapshot
}): Promise<void> {
  try {
    const profile =
      args.profile ??
      (() => {
        const view = clientProfileToApiProfile(getActiveApiProfile(useStore.getState().settings))
        return {
          apiProvider: view.provider,
          apiProfileId: view.id,
          apiProfileName: view.name,
          apiModel: view.model,
        }
      })()
    const { outputIds } = await storeGeneratedImages(args.images)
    const finishedAt = Date.now()
    const elapsed = args.elapsed ?? null
    const newTask: TaskRecord = {
      id: genId(),
      prompt: args.prompt,
      params: args.params,
      ...profile,
      inputImageIds: [],
      maskTargetImageId: null,
      maskImageId: null,
      outputImages: outputIds,
      status: 'done',
      error: null,
      createdAt: elapsed != null ? finishedAt - elapsed : finishedAt,
      finishedAt,
      elapsed,
    }
    useStore.getState().setTasks([newTask, ...useStore.getState().tasks])
    await putTask(newTask)
  } catch (err) {
    console.warn('canvas task history write failed:', err)
  }
}

/**
 * 把一条任务的输出图送进创作模式画布：取全分辨率原图 → 入 handoff 队列 → 切到 create 模式，
 * 由画布 onMount 消费队列放图。默认送第一张输出图。
 */
export async function sendTaskToCanvas(task: TaskRecord, imageId?: string) {
  const { queueCanvasImages, setAppMode, showToast } = useStore.getState()
  const targetId = imageId ?? task.outputImages?.[0]
  if (!targetId) return

  const dataUrl = await ensureImageCached(targetId)
  if (!dataUrl) {
    showToast('图片已不存在，无法送入画布', 'error')
    return
  }
  queueCanvasImages([dataUrl])
  setAppMode('create')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } =
    useStore.getState()

  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter((t) => !toDelete.has(t.id))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
      for (const id of t.transparentOriginalImages || []) {
        if (id) deletedImageIds.add(id)
      }
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
    for (const id of t.transparentOriginalImages || []) {
      if (id) stillUsed.add(id)
    }
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter((id) => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
    ...(task.transparentOriginalImages || []).filter(Boolean),
  ])

  // 从列表移除
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
    for (const id of t.transparentOriginalImages || []) {
      if (id) stillUsed.add(id)
    }
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } =
    useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await clearImages()
    imageCache.clear()
    thumbnailCache.clear()
    thumbnailBackfillIds.clear()
    setTasks([])
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    useStore.setState({ dismissedCodexCliPrompts: [] })
    setSettings({ ...DEFAULT_SETTINGS })
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

/** 从 dataUrl 解析出 MIME 扩展名和二进制数据 */
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

/** 将二进制数据还原为 dataUrl。chunked 编码委托 imageApiShared，防大图 stack overflow。 */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
  }
  return sharedBytesToDataUrl(bytes, mimeMap[ext] ?? 'image/png')
}

async function completeRecoveredCustomTask(
  task: TaskRecord,
  result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>,
) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const { outputIds, outputDataUrls, transparentOriginalImageIds } = await storeGeneratedImages(
    result.images,
    task,
  )
  const actualParamsList = await readImageSizeParamsList(outputDataUrls)

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    customRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = task.apiProvider
    ? getCustomProviderDefinition(settings, task.apiProvider)
    : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  if (profile.source !== 'user-byok') {
    scheduleCustomRecovery(taskId)
    return
  }
  const view = clientProfileToApiProfile(profile)
  const byokAdapter = {
    baseUrl: view.baseUrl,
    apiKey: view.apiKey,
    model: view.model,
    apiMode: view.apiMode,
    timeout: view.timeout,
    codexCli: view.codexCli,
    apiProxy: view.apiProxy,
    responseFormatB64Json: view.responseFormatB64Json,
  }
  try {
    const result = await getCustomQueuedImageResult(
      byokAdapter,
      customProvider,
      task.customTaskId,
      task.params,
    )
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      ...getRawErrorPayload(err),
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

function formatExportFileTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(
  options: ExportOptions = { exportConfig: true, exportTasks: true },
) {
  try {
    const tasks = options.exportTasks ? await getAllTasks() : []
    const images = options.exportTasks ? await getAllImages() : []
    const { settings } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    if (options.exportTasks) {
      for (const task of tasks) {
        for (const id of [
          ...(task.inputImageIds || []),
          ...(task.maskImageId ? [task.maskImageId] : []),
          ...(task.outputImages || []),
        ]) {
          const prev = imageCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            imageCreatedAtFallback.set(id, task.createdAt)
          }
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    if (options.exportTasks) {
      for (const img of images) {
        const { ext, bytes } = dataUrlToBytes(img.dataUrl)
        const path = `images/${img.id}.${ext}`
        const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
        imageFiles[img.id] = {
          path,
          createdAt,
          source: img.source,
          width: img.width,
          height: img.height,
        }
        zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]

        const thumbnail = await getImageThumbnail(img.id)
        if (thumbnail?.thumbnailDataUrl) {
          const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(
            thumbnail.thumbnailDataUrl,
          )
          const thumbnailPath = `thumbnails/${img.id}.${thumbnailExt}`
          imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
          imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
          thumbnailFiles[img.id] = {
            path: thumbnailPath,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          }
          zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt) }]
          cacheThumbnail(img.id, {
            dataUrl: thumbnail.thumbnailDataUrl,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          })
        }
      }
    }

    const manifest: ExportData = {
      version: 3,
      exportedAt: new Date(exportedAt).toISOString(),
    }

    if (options.exportConfig) {
      // 剥掉内置 profile，避免硬编码 apiKey 被导出
      manifest.settings = {
        ...settings,
        profiles: settings.profiles.filter((p) => p.source !== 'builtin-edge'),
      }
    }
    if (options.exportTasks) {
      manifest.tasks = tasks
      manifest.imageFiles = imageFiles
      manifest.thumbnailFiles = thumbnailFiles
    }

    zipFiles['manifest.json'] = [
      strToU8(JSON.stringify(manifest, null, 2)),
      { mtime: new Date(exportedAt) },
    ]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `image-playground-${formatExportFileTime(new Date(exportedAt))}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(
  file: File,
  options: ImportOptions = { importConfig: true, importTasks: true },
): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))

    const importedImageIds: string[] = []
    if (options.importTasks && data.tasks && data.imageFiles) {
      // 还原图片
      for (const [id, info] of Object.entries(data.imageFiles)) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const dataUrl = bytesToDataUrl(bytes, info.path)
        await putImage({
          id,
          dataUrl,
          createdAt: info.createdAt,
          source: info.source,
          width: info.width,
          height: info.height,
        })
        cacheImage(id, dataUrl)
        importedImageIds.push(id)
      }

      for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const thumbnailDataUrl = bytesToDataUrl(bytes, info.path)
        await putImageThumbnail({
          id,
          thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
        cacheThumbnail(id, {
          dataUrl: thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
      }

      for (const task of data.tasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      useStore.getState().setTasks(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    let msg = '数据已成功导入'
    if (options.importTasks && data.tasks) {
      msg = `已导入 ${data.tasks.length} 条记录`
    } else if (options.importConfig && data.settings) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    return false
  }
}

/**
 * 存一张本地图片文件到图片库。`compress` 只给素材开：素材图长期躺在 IndexedDB 里，
 * 参考图的压缩留到提交时统一做，提早压会连带改掉遮罩对齐的那张底图。
 */
export async function storeImageFromFile(
  file: File,
  options: { compress?: boolean } = {},
): Promise<{ id: string; dataUrl: string }> {
  const raw = await fileToDataUrl(file)
  const dataUrl = options.compress ? ((await compressInputImageDataUrls([raw]))[0] ?? raw) : raw
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  useStore.getState().addInputImage(await storeImageFromFile(file))
}

/** 把一张图片存进 image store —— 支持 data/blob/http URL */
export async function storeImageFromUrl(src: string): Promise<{ id: string; dataUrl: string }> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单） */
export async function addImageFromUrl(src: string): Promise<string> {
  const { id, dataUrl } = await storeImageFromUrl(src)
  useStore.getState().addInputImage({ id, dataUrl })
  return id
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
