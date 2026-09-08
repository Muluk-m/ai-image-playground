import type { StoryboardPlan } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../../features/video/store'
import { storyboardStore } from '../../../../features/video/storyboard/lib/storyboardStore'
import {
  INITIAL_STORYBOARD_DRAFT,
  useStoryboardStore,
} from '../../../../features/video/storyboard/store'
import type { StoryboardPlanInput } from '../../../../features/video/storyboard/types'
import { setChannels } from '../../../../lib/channels/channelStore'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'
import { GROK_CHANNEL, IMAGE_CHANNEL } from '../fixtures'

const planStoryboard = vi.hoisted(() => vi.fn())
const submitPrepared = vi.hoisted(() => vi.fn(async () => ['task-1']))
const ensureImageCached = vi.hoisted(() =>
  vi.fn(async (id: string) => `data:image/png;base64,${id}`),
)
const submitVideoRequest = vi.hoisted(() => vi.fn(async () => 'req-1'))
const awaitQueueOutputs = vi.hoisted(() => vi.fn(async () => [{ index: 0, mime: 'video/mp4' }]))

vi.mock('../../../../lib/storyboardClient', () => ({ planStoryboard }))
vi.mock('../../../../lib/channels/queueClient', () => ({ submitVideoRequest, awaitQueueOutputs }))
vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  submitPrepared,
  ensureImageCached,
}))

const showToast = vi.fn()

const PLAN: StoryboardPlan = {
  title: '夏日冰饮',
  summary: '三镜讲清一杯冰饮的诞生',
  shots: [
    {
      no: 1,
      title: '开场',
      description: '玻璃杯放在吧台，晨光斜照',
      camera: '缓慢推进',
      line: '',
      seconds: 5,
      imagePrompt: '吧台上的空玻璃杯，晨光',
      videoPrompt: '镜头缓慢推进，光线渐亮',
    },
    {
      no: 2,
      title: '注水',
      description: '气泡水注入杯中',
      camera: '手持跟拍',
      line: '就是这一口',
      seconds: 5,
      imagePrompt: '气泡水注入玻璃杯',
      videoPrompt: '液体注入，气泡上升',
    },
  ],
}

function planInput(overrides: Partial<StoryboardPlanInput> = {}): StoryboardPlanInput {
  return {
    ...INITIAL_STORYBOARD_DRAFT,
    idea: '一杯夏日冰饮',
    shots: 2,
    aspectRatio: '16:9',
    referenceImageId: null,
    ...overrides,
  }
}

function board() {
  return useStoryboardStore.getState().storyboards[0]!
}

/** 提交后的落盘与轮询都挂在微任务上。 */
async function settle() {
  for (let round = 0; round < 6; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function taskMap(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((task) => [task.id, task]))
}

function doneTask(id: string, imageId: string): TaskRecord {
  return {
    id,
    prompt: '',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [imageId],
    status: 'done',
    error: null,
    createdAt: 1_000,
    finishedAt: 2_000,
    elapsed: 1_000,
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([IMAGE_CHANNEL, GROK_CHANNEL])
  useStore.setState({ showToast, tasks: [] })
  useVideoStore.setState({ tasks: [], loaded: false, draft: INITIAL_VIDEO_DRAFT })
  useVideoStore.getState().syncModelOptions()
  useStoryboardStore.setState({
    storyboards: [],
    activeId: null,
    loading: false,
    draft: INITIAL_STORYBOARD_DRAFT,
  })
  planStoryboard.mockResolvedValue(PLAN)
  let created = 0
  submitPrepared.mockImplementation(async () => [`task-${++created}`])
})

afterEach(() => {
  setChannels([])
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('生成脚本与分镜图', () => {
  it('落一条记录，并按镜逐条提交出图任务', async () => {
    const id = await useStoryboardStore.getState().plan(planInput())

    expect(id).toBeTruthy()
    expect(planStoryboard).toHaveBeenCalledWith({
      idea: '一杯夏日冰饮',
      shots: 2,
      secondsPerShot: 5,
      aspectRatio: '16:9',
    })
    expect(submitPrepared).toHaveBeenCalledTimes(2)
    expect(submitPrepared).toHaveBeenNthCalledWith(1, {
      prompt: '吧台上的空玻璃杯，晨光',
      inputImages: [],
      params: expect.objectContaining({ size: '1280x720', n: 1 }),
      origin: { setId: id, shotId: 'shot-1', kind: 'storyboard' },
    })
    expect(submitPrepared).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ origin: { setId: id, shotId: 'shot-2', kind: 'storyboard' } }),
    )

    expect(board()).toMatchObject({ title: '夏日冰饮', idea: '一杯夏日冰饮', style: '不限' })
    expect(board().shots.map((shot) => shot.imageTaskId)).toEqual(['task-1', 'task-2'])
    expect(await storyboardStore.list()).toHaveLength(1)
  })

  it('带参考图时把它交给脚本和每一镜的出图', async () => {
    await useStoryboardStore
      .getState()
      .plan(planInput({ referenceImageId: 'ref-1', style: '杂志' }))

    expect(planStoryboard).toHaveBeenCalledWith(
      expect.objectContaining({
        style: '杂志',
        referenceImage: 'data:image/png;base64,ref-1',
      }),
    )
    expect(submitPrepared).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inputImages: [{ id: 'ref-1', dataUrl: 'data:image/png;base64,ref-1' }],
      }),
    )
  })

  it('竖版分镜按 9:16 出图', async () => {
    await useStoryboardStore.getState().plan(planInput({ aspectRatio: '9:16' }))

    expect(submitPrepared).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ params: expect.objectContaining({ size: '720x1280' }) }),
    )
  })

  it('脚本请求失败时不留记录', async () => {
    planStoryboard.mockRejectedValue(new Error('上游不可用'))

    expect(await useStoryboardStore.getState().plan(planInput())).toBeNull()
    expect(useStoryboardStore.getState().storyboards).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith('上游不可用', 'error')
  })
})

describe('镜头文案', () => {
  it('改动落盘', async () => {
    const id = await useStoryboardStore.getState().plan(planInput())
    await useStoryboardStore
      .getState()
      .updateShot(id!, 2, { description: '气泡水缓缓注入', videoPrompt: '气泡上升到杯口' })

    expect(board().shots[1]).toMatchObject({
      description: '气泡水缓缓注入',
      videoPrompt: '气泡上升到杯口',
    })
    const stored = (await storyboardStore.list())[0]!
    expect(stored.shots[1]!.description).toBe('气泡水缓缓注入')
  })
})

describe('出图完成', () => {
  it('把工作台任务的出图挂回对应的镜', async () => {
    await useStoryboardStore.getState().plan(planInput())

    useStoryboardStore
      .getState()
      .adoptShotImages(taskMap([doneTask('task-1', 'image-1'), doneTask('task-2', 'image-2')]))
    await settle()

    expect(board().shots.map((shot) => shot.imageId)).toEqual(['image-1', 'image-2'])
  })
})

describe('生视频', () => {
  async function plannedWithImages() {
    const id = await useStoryboardStore.getState().plan(planInput())
    useStoryboardStore
      .getState()
      .adoptShotImages(taskMap([doneTask('task-1', 'image-1'), doneTask('task-2', 'image-2')]))
    await settle()
    return id!
  }

  it('用这一镜的图、提示词和时长提交一条图生视频', async () => {
    const id = await plannedWithImages()

    await useStoryboardStore.getState().generateShotVideo(id, 2)
    await settle()

    const task = useVideoStore.getState().tasks[0]!
    expect(task).toMatchObject({
      source: 'image',
      prompt: '液体注入，气泡上升',
      duration: 5,
      firstFrameImageId: 'image-2',
      storyboardId: id,
      shotNo: 2,
    })
    expect(submitVideoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '液体注入，气泡上升',
        video: expect.objectContaining({ duration_seconds: 5, first_frame_index: 0 }),
        inputImageDataUrls: ['data:image/png;base64,image-2'],
      }),
    )
    expect(board().shots[1]!.videoTaskId).toBe(task.id)
  })

  it('还没出图的镜不提交', async () => {
    const id = await useStoryboardStore.getState().plan(planInput())

    await useStoryboardStore.getState().generateShotVideo(id!, 1)

    expect(useVideoStore.getState().tasks).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith('这一镜还没有分镜图', 'error')
  })

  it('全部生视频只提交还没提交过的镜', async () => {
    const id = await plannedWithImages()
    await useStoryboardStore.getState().generateShotVideo(id, 1)
    await settle()

    await useStoryboardStore.getState().generateAllVideos(id)
    await settle()

    expect(useVideoStore.getState().tasks).toHaveLength(2)
    expect(board().shots.every((shot) => shot.videoTaskId !== null)).toBe(true)
  })
})
