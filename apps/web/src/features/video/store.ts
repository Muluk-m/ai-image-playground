import {
  VIDEO_MODEL_SUPPORT,
  type VideoAspectRatio,
  type VideoDeriveMode,
  type VideoDuration,
  type VideoRequest,
  type VideoResolution,
  validateVideoPrompt,
  validateVideoRequest,
  videoDurationsForResolution,
  videoRateMultiplier,
} from '@image-playground/shared'
import { create } from 'zustand'
import { getStoredChannel } from '../../lib/channels/channelStore'
import { awaitQueueOutputs, submitVideoRequest } from '../../lib/channels/queueClient'
import {
  durationModelOption,
  firstFrameModelOption,
  type VideoModelOption,
  videoModelOptions,
} from '../../lib/channels/videoChannels'
import { getImageThumbnail } from '../../lib/db'
import {
  getPrivateSubmissionGuard,
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from '../../lib/privateOverlay'
import { ensureImageCached, storeImageFromFile, useStore } from '../../store'
import { checkDerive, DERIVE_RESOLUTION } from './lib/derive'
import {
  appendCameraMove,
  clampDraftToSupport,
  clampToSupported,
  videoDraftFromTask,
} from './lib/draft'
import { videoTaskStore } from './lib/videoStore'
import type { VideoDraft, VideoFrameSlot, VideoSource, VideoTask } from './types'

const EMPTY_PROMPT = '请先写一句描述'
const NO_FIRST_FRAME = '请先放一张首帧图'
const NO_MODEL = '当前部署没有可用的视频模型'
const FRAME_MISSING = '首尾帧图片已丢失'
const SOURCE_GONE = '源视频已不在'

export function unsupportedDurationReason(seconds: number): string {
  return `当前模型不支持 ${seconds} 秒`
}

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

/** 分镜的视频提交；清晰度沿用左栏，时长与比例来自分镜。 */
export interface StoryboardVideoInput {
  storyboardId: string
  /** 缺席即整条视频。 */
  shotNo?: number
  imageId: string | null
  prompt: string
  seconds: number
  aspectRatio: VideoAspectRatio
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
  /** 从一条成品视频派生一条新任务，参数不经左栏草稿。 */
  deriveVideo(
    origin: VideoTask,
    input: { mode: VideoDeriveMode; prompt: string; seconds: number },
  ): Promise<string | null>
  submitFromStoryboard(input: StoryboardVideoInput): Promise<string | null>
  /** 整条分镜出一条视频，时长是分镜总时长。 */
  submitStoryboardVideo(input: StoryboardVideoInput): Promise<string | null>
  /** 把这条的参数填回左栏，不提交。 */
  loadDraft(task: VideoTask): void
  regenerate(task: VideoTask): Promise<string | null>
  removeTask(id: string): Promise<void>
  setThumbnail(id: string, thumbnailDataUrl: string): Promise<void>
  /** 图生任务上游不返回尺寸，只能由播放器 metadata 回填。 */
  setDimensions(id: string, width: number, height: number): Promise<void>
}

function byNewest(tasks: VideoTask[]): VideoTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 首尾帧下标指向 input_images：首帧永远 0，尾帧跟在它后面。派生任务不带帧，改带源片的
 * BFF request_id —— 本地 id 上游不认，所以到提交这一刻才换。
 */
function videoRequestOf(task: VideoTask, tasks: VideoTask[]): VideoRequest {
  const request: VideoRequest = {
    duration_seconds: task.duration,
    aspect_ratio: task.aspectRatio,
    resolution: task.resolution,
  }
  if (task.derived) {
    const { mode, sourceTaskId } = task.derived
    const origin = tasks.find((item) => item.id === sourceTaskId)
    if (!origin?.bffRequestId || origin.outputIndex === undefined) throw new Error(SOURCE_GONE)
    request.mode = mode
    request.source_task_id = origin.bffRequestId
    request.source_output_index = origin.outputIndex
    return request
  }
  if (task.firstFrameImageId) request.first_frame_index = 0
  if (task.lastFrameImageId) request.last_frame_index = task.firstFrameImageId ? 1 : 0
  return request
}

interface EnqueueInput {
  option: VideoModelOption
  source: VideoSource
  prompt: string
  duration: number
  aspectRatio: VideoAspectRatio
  resolution: VideoResolution
  firstFrameImageId?: string | null
  lastFrameImageId?: string | null
  derived?: { mode: VideoDeriveMode; sourceTaskId: string }
  shot?: Pick<VideoTask, 'storyboardId' | 'shotNo'>
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
          video: videoRequestOf(task, get().tasks),
          inputImageDataUrls: await frameDataUrls(task),
          clientRequestId: task.clientRequestId,
        })
        notifyPrivateSubmissionAccepted()
      }
      await patch(id, { bffRequestId: requestId, status: 'running' })
      const outputs = await awaitQueueOutputs(requestId)
      const output = outputs[0]!
      await patch(id, {
        status: 'done',
        error: null,
        outputIndex: output.index,
        completedAt: Date.now(),
        ...(output.width && output.height ? { width: output.width, height: output.height } : {}),
      })
    } catch (err) {
      notifyPrivateSubmissionError(err)
      await patch(id, { status: 'error', error: errorMessage(err), completedAt: Date.now() })
    } finally {
      notifyPrivateSubmissionSettled()
    }
  }

  /** 所有提交入口的收口：校验、门禁、落盘。 */
  async function enqueue(input: EnqueueInput): Promise<string | null> {
    const { showToast } = useStore.getState()
    const prompt = input.prompt.trim()
    if (!prompt) {
      showToast(EMPTY_PROMPT, 'error')
      return null
    }
    const task: VideoTask = {
      id: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID(),
      channelId: input.option.channelId,
      source: input.source,
      prompt,
      model: input.option.modelId,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      status: 'queued',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      ...(input.firstFrameImageId ? { firstFrameImageId: input.firstFrameImageId } : {}),
      ...(input.lastFrameImageId ? { lastFrameImageId: input.lastFrameImageId } : {}),
      ...(input.derived ? { derived: input.derived } : {}),
      ...input.shot,
    }

    let video: VideoRequest
    try {
      video = videoRequestOf(task, get().tasks)
    } catch (err) {
      showToast(errorMessage(err), 'error')
      return null
    }
    const frameCount = [task.firstFrameImageId, task.lastFrameImageId].filter(Boolean).length
    for (const check of [
      validateVideoRequest(task.model, video, frameCount),
      validateVideoPrompt(task.model, prompt),
    ])
      if (!check.ok) {
        showToast(check.reason, 'error')
        return null
      }

    const guard = getPrivateSubmissionGuard({
      model: task.model,
      quantity: task.duration,
      unitMultiplier: videoRateMultiplier(task.model, task.resolution),
    })
    if (guard.blocked) {
      if (guard.disabledReason) showToast(guard.disabledReason, 'error')
      guard.blockedAction?.run()
      return null
    }
    if (guard.estimatedCredits !== undefined) task.credits = guard.estimatedCredits

    if (task.firstFrameImageId) {
      const thumbnail = await getImageThumbnail(task.firstFrameImageId).catch(() => undefined)
      if (thumbnail?.thumbnailDataUrl) task.thumbnailDataUrl = thumbnail.thumbnailDataUrl
    }

    set((state) => ({ tasks: byNewest([task, ...state.tasks]) }))
    await videoTaskStore.put(task)
    void runTask(task.id)
    return task.id
  }

  /** 分镜的秒数不一定落在模型档位上（每镜时长是总时长均分出来的），落不上就退到第一档。 */
  function enqueueStoryboard(
    option: VideoModelOption,
    input: StoryboardVideoInput,
  ): Promise<string | null> {
    const { support } = option
    const resolution = clampToSupported(support.resolutions, get().draft.resolution)
    return enqueue({
      option,
      source: input.imageId ? 'image' : 'text',
      prompt: input.prompt,
      duration: clampToSupported(
        videoDurationsForResolution(support, resolution) as readonly number[],
        input.seconds,
      ),
      aspectRatio: clampToSupported(support.aspectRatios, input.aspectRatio),
      resolution,
      firstFrameImageId: input.imageId,
      shot: {
        storyboardId: input.storyboardId,
        ...(input.shotNo === undefined ? {} : { shotNo: input.shotNo }),
      },
    })
  }

  async function enqueueDraft(draft: VideoDraft): Promise<string | null> {
    const { showToast } = useStore.getState()
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

    return await enqueue({
      option,
      source: draft.source,
      prompt: draft.prompt,
      duration: draft.duration,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      firstFrameImageId,
      lastFrameImageId,
    })
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
      set((state) => {
        const support = VIDEO_MODEL_SUPPORT[state.draft.model]
        const draft = { ...state.draft, resolution }
        return { draft: support ? clampDraftToSupport(draft, support) : draft }
      })
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
      return enqueueDraft(get().draft)
    },

    submitFromStoryboard(input) {
      const option = firstFrameModelOption(get().draft.model)
      if (!option) {
        useStore.getState().showToast(NO_MODEL, 'error')
        return Promise.resolve(null)
      }
      return enqueueStoryboard(option, input)
    },

    submitStoryboardVideo(input) {
      const option = durationModelOption(get().draft.model, input.seconds, Boolean(input.imageId))
      if (!option) {
        useStore.getState().showToast(unsupportedDurationReason(input.seconds), 'error')
        return Promise.resolve(null)
      }
      return enqueueStoryboard(option, input)
    },

    deriveVideo(origin, input) {
      const check = checkDerive(origin, input.mode)
      if (!check.ok) {
        useStore.getState().showToast(check.reason, 'error')
        return Promise.resolve(null)
      }
      return enqueue({
        option: check.option,
        source: 'text',
        prompt: input.prompt,
        duration: input.seconds,
        aspectRatio: origin.aspectRatio,
        resolution: DERIVE_RESOLUTION,
        derived: { mode: input.mode, sourceTaskId: origin.id },
      })
    },

    loadDraft(task) {
      set({ draft: videoDraftFromTask(task) })
    },

    regenerate(task) {
      // 派生任务没有左栏表示，照抄原参数重提，别经过草稿。
      if (task.derived) {
        const option = videoModelOptions().find((item) => item.modelId === task.model)
        if (!option) {
          useStore.getState().showToast(NO_MODEL, 'error')
          return Promise.resolve(null)
        }
        return enqueue({
          option,
          source: task.source,
          prompt: task.prompt,
          duration: task.duration,
          aspectRatio: task.aspectRatio,
          resolution: task.resolution,
          derived: task.derived,
        })
      }
      const draft = videoDraftFromTask(task)
      set({ draft })
      return enqueueDraft(draft)
    },

    async removeTask(id) {
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }))
      await videoTaskStore.remove(id)
    },

    setThumbnail(id, thumbnailDataUrl) {
      return patch(id, { thumbnailDataUrl })
    },

    setDimensions(id, width, height) {
      return patch(id, { width, height })
    },
  }
})
