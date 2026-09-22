// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mirrorGenerations, taskFromGeneration } from '../../lib/cloudMirror'
import { getAllTasks, putTask } from '../../lib/db'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'

const readRemoteGeneration = vi.hoisted(() => vi.fn())
vi.mock('../../lib/remoteGenerations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remoteGenerations')>()),
  readRemoteGeneration,
}))

const summary = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  archiveStatus: 'none',
  errorType: null,
  cover: {
    index: 0,
    mediaId: '22222222-2222-4222-8222-222222222222',
    width: 1536,
    height: 1024,
    contentType: 'image/webp',
  },
  createdAt: 1789600000000,
  startedAt: 1789600000000,
  completedAt: 1789600004000,
  revision: '1',
  prompt: '一只猫',
  parameters: { size: '1536x1024', quality: 'high', n: 2, output_format: 'webp' },
  actualParameters: { size: '1536x1024' },
  inputs: [
    {
      index: 0,
      mediaId: '66666666-6666-4666-8666-666666666666',
      width: 1024,
      height: 1024,
      contentType: 'image/png',
    },
  ],
  mask: null,
} as const

beforeEach(() => {
  // 只替换 setTimeout：fake-indexeddb 靠 setImmediate 推进，一起冻住就读不出任务了。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  readRemoteGeneration.mockReset()
  readRemoteGeneration.mockResolvedValue(null)
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ tasks: [], params: { ...DEFAULT_PARAMS } })
})

afterEach(() => {
  vi.useRealTimers()
})

it('平台记录变成一条普通任务记录：封面用云媒体引用，参数与耗时照接口', () => {
  const task = taskFromGeneration(summary)
  expect(task).toMatchObject({
    id: summary.id,
    bffRequestId: summary.id,
    prompt: '一只猫',
    status: 'done',
    apiModel: 'gpt-image-2',
    outputImages: [`aip-media:${summary.cover.mediaId}`],
    actualParams: { size: '1536x1024' },
    elapsed: 4000,
    remoteOnly: true,
  })
  expect(task.params).toMatchObject({ size: '1536x1024', quality: 'high', n: 2 })
})

it('参考图、遮罩与 provider 都跟着列表落到镜像卡上：复用不用再读一次详情', () => {
  const task = taskFromGeneration({
    ...summary,
    mask: { ...summary.inputs[0], mediaId: '77777777-7777-4777-8777-777777777777' },
  })
  expect(task).toMatchObject({
    cloudProvider: 'openai-compat',
    inputImageIds: ['aip-media:66666666-6666-4666-8666-666666666666'],
    maskImageId: 'aip-media:77777777-7777-4777-8777-777777777777',
    maskTargetImageId: 'aip-media:66666666-6666-4666-8666-666666666666',
  })
})

it('Gemini 的比例、分辨率和思考级别照抄，复用不会悄悄换掉画面', () => {
  const task = taskFromGeneration({
    ...summary,
    provider: 'gemini',
    parameters: { aspect_ratio: '3:4', image_size: '2K', thinking_level: 'high' },
  })
  expect(task.params).toMatchObject({
    gemini_aspect_ratio: '3:4',
    gemini_image_size: '2K',
    gemini_thinking_level: 'high',
  })
})

it('早先版本镜下来、没有参考图的卡，再读一页列表就补齐', async () => {
  await mirrorGenerations([summary])
  const stale = { ...useStore.getState().tasks[0]!, cloudProvider: undefined, inputImageIds: [] }
  useStore.setState({ tasks: [stale] })
  await putTask(stale)

  await mirrorGenerations([summary])

  expect(useStore.getState().tasks).toMatchObject([
    {
      cloudProvider: 'openai-compat',
      inputImageIds: ['aip-media:66666666-6666-4666-8666-666666666666'],
    },
  ])
})

it.each([
  ['queued', 'running'],
  ['in_progress', 'running'],
  ['failed', 'error'],
  ['cancelled', 'error'],
] as const)('平台状态 %s 映射成本机状态 %s', (status, expected) => {
  expect(taskFromGeneration({ ...summary, status }).status).toBe(expected)
})

it('同一条生成不会镜像两次：本机已有它就保持本机那条', async () => {
  useStore.setState({
    tasks: [
      {
        id: 'local-1',
        bffRequestId: summary.id,
        prompt: '本机记录',
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: [],
        status: 'done',
        error: null,
        createdAt: summary.createdAt,
        finishedAt: summary.createdAt,
        elapsed: 1,
      },
    ],
  })
  await mirrorGenerations([summary])
  expect(useStore.getState().tasks.map((task) => task.id)).toEqual(['local-1'])
  expect(await getAllTasks()).toHaveLength(0)
})

it('重复读同一页不会累出第二张卡', async () => {
  await mirrorGenerations([summary])
  await mirrorGenerations([summary])
  expect(useStore.getState().tasks).toHaveLength(1)
  expect(await getAllTasks()).toHaveLength(1)
})

const running = {
  ...summary,
  id: '33333333-3333-4333-8333-333333333333',
  status: 'in_progress',
  cover: null,
  completedAt: null,
} as const

it('再读到同一条已经跑完时，还停在生成中的镜像卡就地收尾', async () => {
  await mirrorGenerations([running])
  expect(useStore.getState().tasks[0]).toMatchObject({ status: 'running', outputImages: [] })

  await mirrorGenerations([
    {
      ...running,
      status: 'completed',
      cover: summary.cover,
      completedAt: running.startedAt + 7000,
    },
  ])

  expect(useStore.getState().tasks).toHaveLength(1)
  expect(useStore.getState().tasks[0]).toMatchObject({
    status: 'done',
    elapsed: 7000,
    finishedAt: running.startedAt + 7000,
    outputImages: [`aip-media:${summary.cover.mediaId}`],
  })
  expect(await getAllTasks()).toMatchObject([{ status: 'done' }])
})

it('没人再读列表时，镜像卡也会自己等到平台跑完', async () => {
  // 每条生成只盯一次，换个 id 才不会被上一条测试留下的那轮挡掉。
  const watched = { ...running, id: '55555555-5555-4555-8555-555555555555' } as const
  readRemoteGeneration.mockResolvedValue({
    ...watched,
    status: 'completed',
    completedAt: watched.startedAt + 9000,
    inputs: [],
    mask: null,
    outputs: [{ ...summary.cover, mediaId: '44444444-4444-4444-8444-444444444444' }],
  })

  await mirrorGenerations([watched])
  await vi.advanceTimersByTimeAsync(600)

  expect(readRemoteGeneration).toHaveBeenCalledWith(watched.id)
  expect(useStore.getState().tasks[0]).toMatchObject({
    status: 'done',
    elapsed: 9000,
    outputImages: ['aip-media:44444444-4444-4444-8444-444444444444'],
  })
})

it('本机自己在跑的那条不被平台状态改写：终态由 executeTask 写', async () => {
  useStore.setState({
    tasks: [
      {
        id: 'local-2',
        bffRequestId: summary.id,
        prompt: '本机记录',
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: summary.createdAt,
        finishedAt: null,
        elapsed: null,
      },
    ],
  })

  await mirrorGenerations([summary])

  expect(useStore.getState().tasks).toMatchObject([{ id: 'local-2', status: 'running' }])
})
