// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, it, vi } from 'vitest'
import { mirrorGenerations, taskFromGeneration } from '../../lib/cloudMirror'
import { getAllTasks } from '../../lib/db'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'

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
} as const

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ tasks: [], params: { ...DEFAULT_PARAMS } })
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
