import {
  VIDEO_MODEL_SUPPORT,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoRequest,
  type VideoResolution,
  validateVideoRequest,
  videoRateMultiplier,
} from '@image-playground/shared'
import { create } from 'zustand'
import { getStoredChannel } from '../../lib/channels/channelStore'
import { awaitQueueOutputs, submitVideoRequest } from '../../lib/channels/queueClient'
import { videoModelOptions } from '../../lib/channels/videoChannels'
import { getImageThumbnail } from '../../lib/db'
import {
  getPrivateSubmissionGuard,
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from '../../lib/privateOverlay'
import { ensureImageCached, storeImageFromFile, useStore } from '../../store'
import { appendCameraMove, clampDraftToSupport, videoDraftFromTask } from './lib/draft'
import { videoTaskStore } from './lib/videoStore'
import type { VideoDraft, VideoFrameSlot, VideoSource, VideoTask } from './types'

const EMPTY_PROMPT = '请先写一句描述'
const NO_FIRST_FRAME = '请先放一张首帧图'
const NO_MODEL = '当前部署没有可用的视频模型'
const FRAME_MISSING = '首尾帧图片已丢失'

export const INITIAL_VIDEO_DRAFT: VideoDraft = {
  source: 'text',
  prompt: '',
  model: '',
  duration: 5,
  aspectRatio: '16:9',
  resolution: '720p',
  firstFrameImageId: null,
  lastFrameImageId: null,
}

export interface VideoState {
  tasks: VideoTask[]
  draft: VideoDraft
  loaded: boolean

  loadTasks(): Promise<void>
  /** 把 draft.model 对齐到当前可用模型，并把档位夹回该模型的合法值。 */
  syncModelOptions(): void

  setSource(source: VideoSource): void
  setPrompt(prompt: string): void
  addCameraMove(move: string): void
  setModel(model: string): void
  setDuration(duration: VideoDuration): void
  setAspectRatio(aspectRatio: VideoAspectRatio): void
  setResolution(resolution: VideoResolution): void

  setFrame(slot: VideoFrameSlot, imageId: string | null): void
  addFrameFromFile(slot: VideoFrameSlot, file: File): Promise<void>
  /** 播放器截帧回填后由 #185 调，切到图生标签并填首帧。 */
  useAsFirstFrame(imageId: string): void

  submit(): Promise<string | null>
  /** 把这条的参数填回左栏，不提交。 */
  loadDraft(task: VideoTask): void
  regenerate(task: VideoTask): Promise<string | null>
  removeTask(id: string): Promise<void>
  setThumbnail(id: string, thumbnailDataUrl: string): Promise<void>
}

function byNewest(tasks: VideoTask[]): VideoTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 首尾帧下标指向 input_images：首帧永远 0，尾帧跟在它后面。 */
function videoRequestOf(params: {
  duration: VideoDuration
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId?: string | null
  lastFrameImageId?: string | null
}): VideoRequest {
  const request: VideoRequest = {
    duration_seconds: params.duration,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution,
  }
  if (params.firstFrameImageId) request.first_frame_index = 0
  if (params.lastFrameImageId) request.last_frame_index = params.firstFrameImageId ? 1 : 0
  return request
}

export const useVideoStore = create<VideoState>((set, get) => {
  async function patch(id: string, changes: Partial<VideoTask>): Promise<void> {
    const current = get().tasks.find((task) => task.id === id)
    if (!current) return
    const next = { ...current, ...changes }
    set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? next : task)) }))
    await videoTaskStore.put(next)
  }

  async function frameDataUrls(task: VideoTask): Promise<string[]> {
    const ids = [task.firstFrameImageId, task.lastFrameImageId].filter(
      (id): id is string => typeof id === 'string',
    )
    return await Promise.all(
      ids.map(async (id) => {
        const dataUrl = await ensureImageCached(id)
        if (!dataUrl) throw new Error(FRAME_MISSING)
        return dataUrl
      }),
    )
  }

  /** 提交与续跑同一条路径：没有 request_id 就先提交，有就直接接着轮询。 */
  async function runTask(id: string): Promise<void> {
    const task = get().tasks.find((item) => item.id === id)
    if (!task) return
    try {
      let requestId = task.bffRequestId
      if (!requestId) {
        const channel = getStoredChannel(task.channelId)
        if (!channel) throw new Error(NO_MODEL)
        requestId = await submitVideoRequest({
          channel,
          model: task.model,
          prompt: task.prompt,
          video: videoRequestOf(task),
          inputImageDataUrls: await frameDataUrls(task),
          clientRequestId: task.clientRequestId,
        })
        notifyPrivateSubmissionAccepted()
      }
      await patch(id, { bffRequestId: requestId, status: 'running' })
      const outputs = await awaitQueueOutputs(requestId)
      await patch(id, {
        status: 'done',
        error: null,
        outputIndex: outputs[0]!.index,
        completedAt: Date.now(),
      })
    } catch (err) {
      notifyPrivateSubmissionError(err)
      await patch(id, { status: 'error', error: errorMessage(err), completedAt: Date.now() })
    } finally {
      notifyPrivateSubmissionSettled()
    }
  }

  async function enqueue(draft: VideoDraft): Promise<string | null> {
    const { showToast } = useStore.getState()
    const prompt = draft.prompt.trim()
    if (!prompt) {
      showToast(EMPTY_PROMPT, 'error')
      return null
    }
    const option = videoModelOptions().find((item) => item.modelId === draft.model)
    if (!option) {
      showToast(NO_MODEL, 'error')
      return null
    }
    const firstFrameImageId = draft.source === 'image' ? draft.firstFrameImageId : null
    const lastFrameImageId =
      draft.source === 'image' && option.support.lastFrame ? draft.lastFrameImageId : null
    if (draft.source === 'image' && !firstFrameImageId) {
      showToast(NO_FIRST_FRAME, 'error')
      return null
    }

    const frameCount = [firstFrameImageId, lastFrameImageId].filter(Boolean).length
    const video = videoRequestOf({ ...draft, firstFrameImageId, lastFrameImageId })
    const validation = validateVideoRequest(option.modelId, video, frameCount)
    if (!validation.ok) {
      showToast(validation.reason, 'error')
      return null
    }

    const guard = getPrivateSubmissionGuard({
      model: option.modelId,
      quantity: draft.duration,
      unitMultiplier: videoRateMultiplier(draft.resolution),
    })
    if (guard.blocked) {
      if (guard.disabledReason) showToast(guard.disabledReason, 'error')
      guard.blockedAction?.run()
      return null
    }

    const task: VideoTask = {
      id: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID(),
      channelId: option.channelId,
      source: draft.source,
      prompt,
      model: option.modelId,
      duration: draft.duration,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      status: 'queued',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      ...(firstFrameImageId ? { firstFrameImageId } : {}),
      ...(lastFrameImageId ? { lastFrameImageId } : {}),
      ...(guard.estimatedCredits === undefined ? {} : { credits: guard.estimatedCredits }),
    }
    if (firstFrameImageId) {
      const thumbnail = await getImageThumbnail(firstFrameImageId).catch(() => undefined)
      if (thumbnail?.thumbnailDataUrl) task.thumbnailDataUrl = thumbnail.thumbnailDataUrl
    }

    set((state) => ({ tasks: byNewest([task, ...state.tasks]) }))
    await videoTaskStore.put(task)
    void runTask(task.id)
    return task.id
  }

  return {
    tasks: [],
    draft: INITIAL_VIDEO_DRAFT,
    loaded: false,

    async loadTasks() {
      const stored = await videoTaskStore.list()
      set({ tasks: byNewest(stored), loaded: true })
      get().syncModelOptions()
      for (const task of stored) {
        if (task.status === 'queued' || task.status === 'running') void runTask(task.id)
      }
    },

    syncModelOptions() {
      const options = videoModelOptions()
      if (options.length === 0) return
      const draft = get().draft
      const option = options.find((item) => item.modelId === draft.model) ?? options[0]!
      set({ draft: clampDraftToSupport({ ...draft, model: option.modelId }, option.support) })
    },

    setSource(source) {
      set((state) => ({ draft: { ...state.draft, source } }))
    },
    setPrompt(prompt) {
      set((state) => ({ draft: { ...state.draft, prompt } }))
    },
    addCameraMove(move) {
      set((state) => ({
        draft: { ...state.draft, prompt: appendCameraMove(state.draft.prompt, move) },
      }))
    },
    setModel(model) {
      const support = VIDEO_MODEL_SUPPORT[model]
      if (!support) return
      set((state) => ({ draft: clampDraftToSupport({ ...state.draft, model }, support) }))
    },
    setDuration(duration) {
      set((state) => ({ draft: { ...state.draft, duration } }))
    },
    setAspectRatio(aspectRatio) {
      set((state) => ({ draft: { ...state.draft, aspectRatio } }))
    },
    setResolution(resolution) {
      set((state) => ({ draft: { ...state.draft, resolution } }))
    },

    setFrame(slot, imageId) {
      set((state) => ({
        draft: {
          ...state.draft,
          [slot === 'first' ? 'firstFrameImageId' : 'lastFrameImageId']: imageId,
        },
      }))
    },
    async addFrameFromFile(slot, file) {
      const { id } = await storeImageFromFile(file)
      get().setFrame(slot, id)
    },
    useAsFirstFrame(imageId) {
      set((state) => ({ draft: { ...state.draft, source: 'image', firstFrameImageId: imageId } }))
    },

    submit() {
      return enqueue(get().draft)
    },

    loadDraft(task) {
      set({ draft: videoDraftFromTask(task) })
    },

    regenerate(task) {
      const draft = videoDraftFromTask(task)
      set({ draft })
      return enqueue(draft)
    },

    async removeTask(id) {
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }))
      await videoTaskStore.remove(id)
    },

    setThumbnail(id, thumbnailDataUrl) {
      return patch(id, { thumbnailDataUrl })
    },
  }
})
