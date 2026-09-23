// @vitest-environment jsdom
import type { GenerationSummary } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getCachedGenerations } from '../../lib/db'
import {
  loadPlatformGenerations,
  mergeHistory,
  receivePlatformPage,
  setPlatformFavorite,
  taskFromGeneration,
} from '../../lib/platformGenerations'
import { useStore } from '../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

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

const older: GenerationSummary = {
  ...summary,
  id: '33333333-3333-4333-8333-333333333333',
  createdAt: summary.createdAt - 60_000,
}

beforeEach(() => {
  // 只替换 setTimeout：fake-indexeddb 靠 setImmediate 推进，一起冻住就读不出记录了。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  readRemoteGeneration.mockReset()
  readRemoteGeneration.mockResolvedValue(null)
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ tasks: [], platformGenerations: [], params: { ...DEFAULT_PARAMS } })
})

afterEach(() => {
  vi.useRealTimers()
})

const localTask = (patch: Partial<TaskRecord>): TaskRecord => ({
  id: 'local-1',
  prompt: '本机记录',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  outputImages: [],
  status: 'done',
  error: null,
  createdAt: summary.createdAt,
  finishedAt: summary.createdAt,
  elapsed: 1,
  ...patch,
})

it('平台记录投影成一张普通卡：封面用云媒体引用，参考图、provider 与耗时照接口', () => {
  const task = taskFromGeneration({
    ...summary,
    mask: { ...summary.inputs[0], mediaId: '77777777-7777-4777-8777-777777777777' },
  })
  expect(task).toMatchObject({
    id: summary.id,
    prompt: '一只猫',
    status: 'done',
    apiModel: 'gpt-image-2',
    cloudProvider: 'openai-compat',
    outputImages: [`aip-media:${summary.cover.mediaId}`],
    inputImageIds: ['aip-media:66666666-6666-4666-8666-666666666666'],
    maskImageId: 'aip-media:77777777-7777-4777-8777-777777777777',
    elapsed: 4000,
    remoteOnly: true,
  })
  expect(task.params).toMatchObject({ size: '1536x1024', quality: 'high', n: 2 })
})

it.each([
  ['queued', 'running'],
  ['in_progress', 'running'],
  ['failed', 'error'],
  ['cancelled', 'error'],
] as const)('平台状态 %s 映射成本机状态 %s', (status, expected) => {
  expect(taskFromGeneration({ ...summary, status }).status).toBe(expected)
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

it('平台上删掉的记录，下一次读到同一段时间线就消失——不靠墓碑，也不用拿 404 试探', async () => {
  await receivePlatformPage([summary, older])
  expect(useStore.getState().platformGenerations).toHaveLength(2)

  await receivePlatformPage([summary])

  expect(useStore.getState().platformGenerations.map((row) => row.id)).toEqual([summary.id])
  expect(await getCachedGenerations()).toHaveLength(1)
})

it('这一页覆盖不到的更早记录不受影响：翻页不等于「平台上没有了」', async () => {
  await receivePlatformPage([summary, older])

  // 这一页只读到 summary 为止，下面还有更早的：older 不在这一页的窗口里。
  await receivePlatformPage([summary], { hasMore: true })

  expect(useStore.getState().platformGenerations.map((row) => row.id)).toEqual([
    summary.id,
    older.id,
  ])
})

it('第二页只替换它自己覆盖的那一段，上一页的记录不受影响', async () => {
  await receivePlatformPage([summary, older])

  // 第二页从 older 之前开始，返回空且读到底：窗口是 (-∞, older 之前]，两条都在窗口外。
  await receivePlatformPage([], { until: older.createdAt - 1 })

  expect(useStore.getState().platformGenerations.map((row) => row.id)).toEqual([
    summary.id,
    older.id,
  ])
})

it('收藏是本机标注，刷新缓存时留着', async () => {
  await receivePlatformPage([summary])
  await setPlatformFavorite(summary.id, true)

  await receivePlatformPage([{ ...summary, prompt: '改过的提示词' }])

  const [row] = useStore.getState().platformGenerations
  expect(row).toMatchObject({ favorite: true })
  expect(taskFromGeneration(row!.record, row!.favorite)).toMatchObject({
    prompt: '改过的提示词',
    isFavorite: true,
  })
})

it('刷新后第一帧就有卡：缓存落盘，启动读回来', async () => {
  await receivePlatformPage([summary])
  useStore.setState({ platformGenerations: [] })

  await loadPlatformGenerations()

  expect(useStore.getState().platformGenerations.map((row) => row.id)).toEqual([summary.id])
})

it('本机自己跑的那条压住平台那条：同一条生成只出一张卡', async () => {
  await receivePlatformPage([summary])
  const merged = mergeHistory(
    [localTask({ bffRequestId: summary.id })],
    [...useStore.getState().platformGenerations],
  )

  expect(merged.map((task) => task.id)).toEqual(['local-1'])
})

it('平台记录不写进本机任务表', async () => {
  await receivePlatformPage([summary])

  expect(useStore.getState().tasks).toEqual([])
})
