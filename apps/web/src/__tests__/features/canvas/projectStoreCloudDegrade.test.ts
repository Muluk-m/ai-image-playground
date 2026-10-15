// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectRequestError } from '../../../features/canvas/lib/projectClient'
import { projectRepository } from '../../../features/canvas/lib/projectRepository'
import { projectRouteSegment } from '../../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'
import {
  _resetErrorReportingForTesting,
  configureErrorReporting,
  flushClientErrors,
} from '../../../lib/errorReporting'

const getCloudProject = vi.hoisted(() => vi.fn())
const listCloudProjects = vi.hoisted(() => vi.fn(async () => ({ projects: [], nextCursor: null })))
vi.mock('../../../features/canvas/lib/projectClient', () => ({
  cloudProjectsEnabled: () => true,
  listCloudProjects,
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
  getCloudProject.mockReset()
  listCloudProjects.mockReset()
  listCloudProjects.mockResolvedValue({ projects: [], nextCursor: null })
  setClientStorageScope(null)
  window.history.replaceState(null, '', '/')
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: false,
    cloudError: null,
    error: null,
    routeError: null,
  })
})

it('opens a cached route before the cloud catalog finishes loading', async () => {
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('Cached')
  window.history.replaceState(null, '', `/p/${projectRouteSegment(project.id)}`)
  let finishCatalog!: (page: { projects: []; nextCursor: null }) => void
  listCloudProjects.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCatalog = resolve
      }),
  )

  await useCanvasProjectStore.getState().load()

  expect(useCanvasProjectStore.getState().loaded).toBe(true)
  expect(useCanvasProjectStore.getState().activeId).toBe(project.id)
  expect(listCloudProjects).toHaveBeenCalledOnce()
  finishCatalog({ projects: [], nextCursor: null })
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().cloudLoading).toBe(false))
})

it('a slow deep link is resolved separately without blocking the local catalog', async () => {
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
  // A deep-link failure belongs to navigation, not catalog initialization.
  expect(state.loaded).toBe(true)
  expect(state.error).toBeNull()
  expect(state.activeId).toBeNull()
  expect(getCloudProject).not.toHaveBeenCalled()
  await expect(useCanvasProjectStore.getState().resolve(remote)).rejects.toThrow('signal timed out')
})

it('a missing deep link does not make the local catalog unavailable', async () => {
  setClientStorageScope(crypto.randomUUID())
  const local = await projectRepository.create('Still available')
  window.history.replaceState(null, '', `/p/${projectRouteSegment(crypto.randomUUID())}`)
  getCloudProject.mockRejectedValue(new ProjectRequestError(404, 'project_not_found'))

  await expect(useCanvasProjectStore.getState().load()).resolves.toBeUndefined()

  expect(useCanvasProjectStore.getState()).toMatchObject({ loaded: true, error: null })
  expect(useCanvasProjectStore.getState().projects.map((p) => p.id)).toContain(local.id)
  expect(useCanvasProjectStore.getState().activeId).toBeNull()
  await expect(
    useCanvasProjectStore.getState().resolve(window.location.pathname.slice(3)),
  ).rejects.toMatchObject({ status: 404 })
  expect(useCanvasProjectStore.getState().error).toBeNull()
})

it('preserves the original local storage failure for diagnosis and permits retry', async () => {
  setClientStorageScope(crypto.randomUUID())
  const original = new DOMException('Storage temporarily unavailable', 'UnknownError')
  const read = vi.spyOn(projectRepository, 'list').mockRejectedValueOnce(original)
  try {
    await expect(useCanvasProjectStore.getState().load()).rejects.toMatchObject({ cause: original })
    await useCanvasProjectStore.getState().load()
    expect(useCanvasProjectStore.getState()).toMatchObject({ loaded: true, error: null })
  } finally {
    read.mockRestore()
  }
})

it('does not claim another account recovered a failed catalog', async () => {
  _resetErrorReportingForTesting()
  configureErrorReporting('')
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  setClientStorageScope(crypto.randomUUID())
  const read = vi
    .spyOn(projectRepository, 'list')
    .mockRejectedValueOnce(new Error('storage failure'))
  try {
    await expect(useCanvasProjectStore.getState().load()).rejects.toThrow(
      'Project catalog unavailable',
    )
    flushClientErrors()
    setClientStorageScope(crypto.randomUUID())
    await useCanvasProjectStore.getState().load()
    flushClientErrors()
    const reports = fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    )
    expect(reports).toHaveLength(1)
    expect(reports[0].recoveries).toBeUndefined()
  } finally {
    read.mockRestore()
    vi.unstubAllGlobals()
    _resetErrorReportingForTesting()
  }
})

it('reports original failure details once and recovers only after a successful local retry', async () => {
  _resetErrorReportingForTesting()
  configureErrorReporting('')
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  setClientStorageScope(crypto.randomUUID())
  const read = vi
    .spyOn(projectRepository, 'list')
    .mockRejectedValueOnce(new DOMException('Could not open database', 'UnknownError'))
  try {
    await expect(useCanvasProjectStore.getState().load()).rejects.toThrow(
      'Project catalog unavailable',
    )
    flushClientErrors()
    await useCanvasProjectStore.getState().load()
    flushClientErrors()
    const reports = fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    )
    expect(reports).toHaveLength(2)
    expect(reports[0].errors[0].context).toMatchObject({
      operation: 'project.catalog',
      stage: 'read-local',
      causes: [{ name: 'UnknownError', message: 'Could not open database' }],
    })
    expect(reports[1].recoveries).toEqual([
      { operation: 'project.catalog', incidentId: reports[0].errors[0].context.incidentId },
    ])
  } finally {
    read.mockRestore()
    vi.unstubAllGlobals()
    _resetErrorReportingForTesting()
  }
})
