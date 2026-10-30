// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { CloudProjectSummary } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'

const listCloudProjects = vi.hoisted(() => vi.fn())
vi.mock('../../../features/canvas/lib/projectClient', () => ({
  cloudProjectsEnabled: () => true,
  listCloudProjects,
  getCloudProject: vi.fn(),
  restoreDeletedCloudProject: vi.fn(),
  ensureCloudProjectConversation: vi.fn(),
  PROJECT_REQUEST_TIMEOUT_MS: 30000,
  ProjectRequestError: class ProjectRequestError extends Error {},
}))

function summary(index: number): CloudProjectSummary {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `p${index}`,
    revision: 1,
    createdAt: 1,
    updatedAt: 10_000 - index,
    elementCount: 1,
    coverMediaId: null,
    experience: 'canvas',
  }
}

beforeEach(() => {
  setClientStorageScope(crypto.randomUUID())
  useCanvasProjectStore.setState({
    projects: [],
    cloudCatalog: {},
    cloudCursor: null,
    cloudTotals: null,
    cloudLoading: false,
    cloudError: null,
  })
})

afterEach(() => {
  listCloudProjects.mockReset()
  setClientStorageScope(null)
})

it('第一页是最近更新的 30 个，总数用服务端的；往下翻接着游标读，不重复', async () => {
  const first = Array.from({ length: 30 }, (_, index) => summary(index))
  const second = Array.from({ length: 30 }, (_, index) => summary(index + 30))
  listCloudProjects
    .mockResolvedValueOnce({
      projects: first,
      nextCursor: 'c1',
      totals: { all: 75, chat: 0 },
      deletedIds: [],
      deletedThrough: 5000,
    })
    .mockResolvedValueOnce({ projects: second, nextCursor: 'c2' })

  await useCanvasProjectStore.getState().refreshCloud()
  expect(listCloudProjects).toHaveBeenLastCalledWith({ deletedSince: undefined })
  expect(useCanvasProjectStore.getState().cloudTotals).toEqual({ all: 75, chat: 0 })
  expect(useCanvasProjectStore.getState().cloudCursor).toBe('c1')

  await useCanvasProjectStore.getState().refreshCloud(true)
  expect(listCloudProjects).toHaveBeenLastCalledWith({ cursor: 'c1' })
  const ids = Object.keys(useCanvasProjectStore.getState().cloudCatalog)
  expect(ids).toHaveLength(60)
  expect(new Set(ids).size).toBe(60)
  // 翻页不带总数，沿用第一页的。
  expect(useCanvasProjectStore.getState().cloudTotals).toEqual({ all: 75, chat: 0 })
})

it('下次刷新第一页只要上次之后删掉的 id；翻到底就不再请求', async () => {
  listCloudProjects.mockResolvedValue({
    projects: [summary(0)],
    nextCursor: null,
    totals: { all: 1, chat: 0 },
    deletedIds: [],
    deletedThrough: 5000,
  })

  await useCanvasProjectStore.getState().refreshCloud()
  await useCanvasProjectStore.getState().refreshCloud(true)
  expect(listCloudProjects).toHaveBeenCalledTimes(1)

  await useCanvasProjectStore.getState().refreshCloud()
  expect(listCloudProjects).toHaveBeenLastCalledWith({ deletedSince: 5000 })
})
