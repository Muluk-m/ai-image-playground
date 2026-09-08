import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { videoTaskStore } from '../../../features/video/lib/videoStore'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../features/video/store'
import type { VideoTask } from '../../../features/video/types'
import { setChannels } from '../../../lib/channels/channelStore'
import { useStore } from '../../../store'
import {
  AGNES_CHANNEL,
  GROK_CHANNEL,
  IMAGE_CHANNEL,
  VEO_CHANNEL,
  VEO_FAST_MODEL,
  videoTask,
} from './fixtures'

const submitVideoRequest = vi.hoisted(() => vi.fn(async () => 'req-1'))
const awaitQueueOutputs = vi.hoisted(() => vi.fn(async () => [{ index: 0, mime: 'video/mp4' }]))
const ensureImageCached = vi.hoisted(() =>
  vi.fn(async (id: string) => `data:image/png;base64,${id}`),
)
const getPrivateSubmissionGuard = vi.hoisted(() => vi.fn(() => ({ blocked: false })))

vi.mock('../../../lib/channels/queueClient', () => ({ submitVideoRequest, awaitQueueOutputs }))

vi.mock('../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store')>()),
  ensureImageCached,
}))

vi.mock('../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/privateOverlay')>()),
  getPrivateSubmissionGuard,
}))

const showToast = vi.fn()

/** 提交后的轮询挂在微任务上，落盘还要 IndexedDB 一轮。 */
async function settle() {
  for (let round = 0; round < 6; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function draft() {
  return useVideoStore.getState().draft
}

function tasks() {
  return useVideoStore.getState().tasks
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([IMAGE_CHANNEL, GROK_CHANNEL, AGNES_CHANNEL, VEO_CHANNEL])
  useStore.setState({ showToast, tasks: [] })
  useVideoStore.setState({ tasks: [], loaded: false, draft: INITIAL_VIDEO_DRAFT })
  useVideoStore.getState().syncModelOptions()
})

afterEach(() => {
  setChannels([])
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  submitVideoRequest.mockResolvedValue('req-1')
  awaitQueueOutputs.mockResolvedValue([{ index: 0, mime: 'video/mp4' }])
  getPrivateSubmissionGuard.mockReturnValue({ blocked: false })
})

describe('提交', () => {
  it('先落一条 queued 记录，再提交并轮询到完成', async () => {
    useVideoStore.getState().setPrompt('浴缸注水，镜头缓慢推进')
    const id = await useVideoStore.getState().submit()

    expect(id).toBeTruthy()
    expect(tasks()).toHaveLength(1)
    expect(tasks()[0]!.status).toBe('queued')
    expect(tasks()[0]!.model).toBe('grok-imagine-video')
    expect(tasks()[0]!.channelId).toBe('grok-video')

    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'grok-imagine-video',
        prompt: '浴缸注水，镜头缓慢推进',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        inputImageDataUrls: [],
      }),
    )
    expect(tasks()[0]!.status).toBe('done')
    expect(tasks()[0]!.bffRequestId).toBe('req-1')
    expect(tasks()[0]!.outputIndex).toBe(0)
    expect(tasks()[0]!.completedAt).toBeTypeOf('number')
    expect(await videoTaskStore.list()).toHaveLength(1)
  })

  it('完成时把输出的实际尺寸写回任务', async () => {
    awaitQueueOutputs.mockResolvedValue([
      { index: 0, mime: 'video/mp4', width: 960, height: 960 },
    ] as never)
    useVideoStore.getState().setPrompt('方图首帧动起来')
    await useVideoStore.getState().submit()
    await settle()

    expect(tasks()[0]).toMatchObject({ status: 'done', width: 960, height: 960 })
    expect((await videoTaskStore.list())[0]).toMatchObject({ width: 960, height: 960 })
  })

  it('上游不给尺寸时任务不带尺寸字段', async () => {
    useVideoStore.getState().setPrompt('没有尺寸的输出')
    await useVideoStore.getState().submit()
    await settle()

    expect(tasks()[0]!.width).toBeUndefined()
    expect(tasks()[0]!.height).toBeUndefined()
  })

  it('图生任务把首帧放 index 0、尾帧放 index 1', async () => {
    const store = useVideoStore.getState()
    store.setModel('agnes-video-2.5-flash')
    store.setSource('image')
    store.setPrompt('水龙头出水到关闭')
    store.setFrame('first', 'img-first')
    store.setFrame('last', 'img-last')
    await store.submit()
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImageDataUrls: ['data:image/png;base64,img-first', 'data:image/png;base64,img-last'],
        video: expect.objectContaining({ first_frame_index: 0, last_frame_index: 1 }),
      }),
    )
  })

  it('缺首帧的图生任务不提交', async () => {
    const store = useVideoStore.getState()
    store.setSource('image')
    store.setPrompt('浴缸注水')
    expect(await store.submit()).toBeNull()
    expect(submitVideoRequest).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('请先放一张首帧图', 'error')
  })

  it('描述超过模型上限时不提交', async () => {
    const cap = VIDEO_MODEL_SUPPORT[VEO_FAST_MODEL].promptMaxChars!
    const store = useVideoStore.getState()
    store.setModel(VEO_FAST_MODEL)
    store.setPrompt('光'.repeat(cap + 1))

    expect(await store.submit()).toBeNull()
    expect(submitVideoRequest).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(`Veo 3.1 Fast 描述最多 ${cap} 字`, 'error')
  })

  it('门禁拦住时不提交，并跑它给的动作', async () => {
    const run = vi.fn()
    getPrivateSubmissionGuard.mockReturnValue({
      blocked: true,
      disabledReason: '积分不足',
      blockedAction: { label: '去充值', run },
    } as never)
    useVideoStore.getState().setPrompt('森林月光慢镜')

    expect(await useVideoStore.getState().submit()).toBeNull()
    expect(submitVideoRequest).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalled()
  })

  it('把门禁算出的积分记进任务', async () => {
    getPrivateSubmissionGuard.mockReturnValue({ blocked: false, estimatedCredits: 480 } as never)
    useVideoStore.getState().setPrompt('霓虹街道')
    await useVideoStore.getState().submit()

    expect(tasks()[0]!.credits).toBe(480)
  })

  it('失败写 error 并留住估算积分', async () => {
    getPrivateSubmissionGuard.mockReturnValue({ blocked: false, estimatedCredits: 300 } as never)
    awaitQueueOutputs.mockRejectedValue(new Error('上游未返回视频'))
    useVideoStore.getState().setPrompt('猫咪铜管乐队')
    await useVideoStore.getState().submit()
    await settle()

    expect(tasks()[0]!.status).toBe('error')
    expect(tasks()[0]!.error).toBe('上游未返回视频')
    expect(tasks()[0]!.credits).toBe(300)
  })
})

describe('派生', () => {
  function seedSource(overrides: Partial<VideoTask> = {}): VideoTask {
    const source = videoTask({ bffRequestId: 'req-src', outputIndex: 2, ...overrides })
    useVideoStore.setState({ tasks: [source] })
    return source
  }

  it('续写按选中的秒数提交，带源片的 request_id 与输出下标', async () => {
    const source = seedSource({ duration: 8, aspectRatio: '9:16' })

    const id = await useVideoStore
      .getState()
      .deriveVideo(source, { mode: 'extend', prompt: '镜头继续拉远', seconds: 5 })
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'grok-imagine-video',
        prompt: '镜头继续拉远',
        inputImageDataUrls: [],
        video: {
          duration_seconds: 5,
          aspect_ratio: '9:16',
          resolution: '720p',
          mode: 'extend',
          source_task_id: 'req-src',
          source_output_index: 2,
        },
      }),
    )
    const derived = tasks().find((task) => task.id === id)!
    expect(derived).toMatchObject({
      duration: 5,
      derived: { mode: 'extend', sourceTaskId: source.id },
    })
  })

  it('改视频沿用源片时长，不带首尾帧下标', async () => {
    const source = seedSource({ duration: 8 })

    await useVideoStore
      .getState()
      .deriveVideo(source, { mode: 'edit', prompt: '把车换成红色', seconds: 8 })
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          duration_seconds: 8,
          aspect_ratio: '16:9',
          resolution: '720p',
          mode: 'edit',
          source_task_id: 'req-src',
          source_output_index: 2,
        },
      }),
    )
  })

  it('源片已被删掉时不提交', async () => {
    const source = videoTask({ bffRequestId: 'req-src', outputIndex: 2 })

    expect(
      await useVideoStore.getState().deriveVideo(source, {
        mode: 'extend',
        prompt: '再来一段',
        seconds: 5,
      }),
    ).toBeNull()
    expect(submitVideoRequest).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('源视频已不在', 'error')
  })

  it('超过 8 秒的源片不给改视频', async () => {
    const source = seedSource({ duration: 10 })

    expect(
      await useVideoStore
        .getState()
        .deriveVideo(source, { mode: 'edit', prompt: '换个天色', seconds: 10 }),
    ).toBeNull()
    expect(showToast).toHaveBeenCalledWith('源片超过 8 秒', 'error')
  })

  it('重生成一条续写仍然指向同一个源片', async () => {
    const source = seedSource({ duration: 5 })
    const id = await useVideoStore
      .getState()
      .deriveVideo(source, { mode: 'extend', prompt: '继续往前推', seconds: 2 })
    await settle()
    submitVideoRequest.mockClear()

    await useVideoStore.getState().regenerate(tasks().find((task) => task.id === id)!)
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          mode: 'extend',
          source_task_id: 'req-src',
          duration_seconds: 2,
        }),
      }),
    )
  })
})

describe('参数', () => {
  it('换模型时把不支持的档位退回合法值', () => {
    const store = useVideoStore.getState()
    store.setModel('grok-imagine-video')
    store.setResolution('1080p')
    expect(draft().resolution).toBe('1080p')

    // Agnes Flash 只有 720P，1080p 必须退回。
    store.setModel('agnes-video-2.5-flash')

    expect(draft().resolution).toBe('720p')
    expect(draft().duration).toBe(5)
  })

  it('换模型时把时长退到该清晰度配得上的档', () => {
    const store = useVideoStore.getState()
    store.setModel('grok-imagine-video')
    store.setResolution('1080p')
    store.setDuration(5)

    // Veo 的 1080p 只配 8 秒。
    store.setModel(VEO_FAST_MODEL)

    expect(draft()).toMatchObject({ resolution: '1080p', duration: 8 })
  })

  it('切到不支持尾帧的模型时留住尾帧图，切回去还在', () => {
    const store = useVideoStore.getState()
    store.setModel('agnes-video-2.5-flash')
    store.setFrame('last', 'img-last')

    store.setModel('grok-imagine-video')
    expect(draft().lastFrameImageId).toBe('img-last')

    store.setModel('agnes-video-2.5-flash')
    expect(draft().lastFrameImageId).toBe('img-last')
  })

  it('留住的尾帧不进 Grok 的提交体', async () => {
    const store = useVideoStore.getState()
    store.setModel('agnes-video-2.5-flash')
    store.setSource('image')
    store.setFrame('first', 'img-first')
    store.setFrame('last', 'img-last')
    store.setModel('grok-imagine-video')
    store.setPrompt('主图动效')
    await store.submit()
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImageDataUrls: ['data:image/png;base64,img-first'],
        video: {
          duration_seconds: 5,
          aspect_ratio: '16:9',
          resolution: '720p',
          first_frame_index: 0,
        },
      }),
    )
    expect(tasks()[0]!.lastFrameImageId).toBeUndefined()
    expect(draft().lastFrameImageId).toBe('img-last')
  })

  it('运镜片段追加到描述末尾', () => {
    const store = useVideoStore.getState()
    store.addCameraMove('缓慢推进')
    expect(draft().prompt).toBe('缓慢推进')
    store.addCameraMove('光线流动')
    expect(draft().prompt).toBe('缓慢推进，光线流动')
  })

  it('用作首帧切到图生标签并填首帧', () => {
    useVideoStore.getState().useAsFirstFrame('img-frame')
    expect(draft().source).toBe('image')
    expect(draft().firstFrameImageId).toBe('img-frame')
  })
})

describe('记录', () => {
  it('删除同时清掉持久化的那条', async () => {
    useVideoStore.getState().setPrompt('沙漠城市日出')
    const id = await useVideoStore.getState().submit()
    await settle()

    await useVideoStore.getState().removeTask(id!)

    expect(tasks()).toHaveLength(0)
    expect(await videoTaskStore.list()).toHaveLength(0)
  })

  it('重生成复制原参数再提交一条', async () => {
    const store = useVideoStore.getState()
    store.setModel('grok-imagine-video')
    store.setPrompt('台盆环绕半圈')
    store.setDuration(8)
    store.setResolution('1080p')
    await store.submit()
    await settle()
    const original = tasks()[0]!

    submitVideoRequest.mockResolvedValue('req-2')
    await useVideoStore.getState().regenerate(original)
    await settle()

    expect(tasks()).toHaveLength(2)
    const copy = tasks().find((task) => task.id !== original.id)!
    expect(copy.prompt).toBe('台盆环绕半圈')
    expect(copy.model).toBe('grok-imagine-video')
    expect(copy.duration).toBe(8)
    expect(copy.resolution).toBe('1080p')
    expect(copy.clientRequestId).not.toBe(original.clientRequestId)
  })

  it('刷新后接着轮询已提交的任务，不重提', async () => {
    const running: VideoTask = {
      id: 'task-1',
      bffRequestId: 'req-existing',
      clientRequestId: 'client-1',
      channelId: 'grok-video',
      source: 'text',
      prompt: '主图动效',
      model: 'grok-imagine-video',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      status: 'running',
      error: null,
      createdAt: 1,
      completedAt: null,
    }
    await videoTaskStore.put(running)

    await useVideoStore.getState().loadTasks()
    await settle()

    expect(submitVideoRequest).not.toHaveBeenCalled()
    expect(awaitQueueOutputs).toHaveBeenCalledWith('req-existing')
    expect(tasks()[0]!.status).toBe('done')
  })

  it('刷新后重提还没拿到 request_id 的任务，沿用同一个幂等 id', async () => {
    const queued: VideoTask = {
      id: 'task-2',
      clientRequestId: 'client-2',
      channelId: 'grok-video',
      source: 'text',
      prompt: '森林月光',
      model: 'grok-imagine-video',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      status: 'queued',
      error: null,
      createdAt: 1,
      completedAt: null,
    }
    await videoTaskStore.put(queued)

    await useVideoStore.getState().loadTasks()
    await settle()

    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: 'client-2' }),
    )
    expect(tasks()[0]!.status).toBe('done')
  })
})
