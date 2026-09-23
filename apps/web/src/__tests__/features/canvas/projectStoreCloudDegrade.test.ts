// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { projectRouteSegment } from '../../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'

const getCloudProject = vi.hoisted(() => vi.fn())
vi.mock('../../../features/canvas/lib/projectClient', () => ({
  cloudProjectsEnabled: () => true,
  listCloudProjects: vi.fn(async () => ({ projects: [], nextCursor: null })),
  getCloudProject,
  restoreDeletedCloudProject: vi.fn(),
  ensureCloudProjectConversation: vi.fn(),
  PROJECT_REQUEST_TIMEOUT_MS: 30000,
  ProjectRequestError: class ProjectRequestError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code)
    }
  },
}))

afterEach(() => {
  setClientStorageScope(null)
  window.history.replaceState(null, '', '/')
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: false,
    cloudError: null,
  })
})

it('地址上那个云端项目读不回来时目录照常可用，只标云端没刷上', async () => {
  setClientStorageScope(crypto.randomUUID())
  const remote = crypto.randomUUID()
  window.history.replaceState(null, '', `/p/${projectRouteSegment(remote)}`)
  getCloudProject.mockImplementation(async () => {
    const error = new Error('signal timed out')
    error.name = 'TimeoutError'
    throw error
  })

  await useCanvasProjectStore.getState().load()

  const state = useCanvasProjectStore.getState()
  // 一次链路抖动不该把整个画布目录判死：本机那份照常起手，只是云端列表没刷上。
  expect(state.loaded).toBe(true)
  expect(state.error).toBeNull()
  expect(state.cloudError).not.toBeNull()
  expect(state.activeId).not.toBeNull()
})
