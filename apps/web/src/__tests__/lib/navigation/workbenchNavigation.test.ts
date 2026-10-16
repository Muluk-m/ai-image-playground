// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../features/agent/store'
import { projectRepository } from '../../../features/canvas/lib/projectRepository'
import { projectRouteSegment } from '../../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../features/library/store'
import { isPricingPath, isPrivacyPath, isTermsPath, pathAppMode } from '../../../lib/appPaths'
import { setClientStorageScope } from '../../../lib/authScope'
import { publishStartedProjectAddress } from '../../../lib/navigation/address'
import {
  backToCurrentProject,
  installWorkbenchNavigation,
} from '../../../lib/navigation/workbenchNavigation'
import { useStore } from '../../../store'

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
  setClientStorageScope(null)
  useStore.setState({ appMode: 'canvas', sidebarExpanded: null })
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false, routeError: null })
})

function popTo(path: string) {
  history.replaceState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

it.each([
  '/',
  '/assets',
  '/pricing',
  '/terms',
  '/privacy',
])('publishes a started project only from root, without an installer (%s)', (path) => {
  history.replaceState(null, '', `${path}?source=entry#canvas`)
  const before = history.length
  publishStartedProjectAddress('new-project')
  expect(location.pathname).toBe(path === '/' ? `/p/${projectRouteSegment('new-project')}` : path)
  expect(location.search + location.hash).toBe('?source=entry#canvas')
  expect(history.length).toBe(before + (path === '/' ? 1 : 0))
})

it('explicitly returns to the current project and clears the error without an installer', () => {
  useCanvasProjectStore.setState({ activeId: 'current', routeError: 'Unavailable' })
  history.replaceState(null, '', '/p/missing?source=error#canvas')
  const before = history.length
  backToCurrentProject()
  expect(location.pathname).toBe(`/p/${projectRouteSegment('current')}`)
  expect(location.search + location.hash).toBe('?source=error#canvas')
  expect(history.length).toBe(before)
  expect(useCanvasProjectStore.getState().routeError).toBeNull()
})

it('explicitly returns home with a hard navigation when there is no current project', () => {
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  useCanvasProjectStore.setState({ activeId: null, routeError: 'Unavailable' })
  backToCurrentProject()
  expect(assign).toHaveBeenCalledWith('/')
  expect(useCanvasProjectStore.getState().routeError).toBe('Unavailable')
})

it('keeps the failed address when opening is refused with no active project', async () => {
  setClientStorageScope(crypto.randomUUID())
  const target = await projectRepository.create('Destination')
  useCanvasProjectStore.setState({ projects: [target], activeId: null, loaded: true })
  const select = vi.spyOn(useAgentStore.getState(), 'selectProject').mockResolvedValueOnce(false)
  history.replaceState(null, '', `/p/${target.id}`)
  cleanup = installWorkbenchNavigation()
  await vi.waitFor(() => expect(select).toHaveBeenCalled())
  expect(location.pathname).toBe(`/p/${target.id}`)
  expect(useCanvasProjectStore.getState().activeId).toBeNull()
  expect(useCanvasProjectStore.getState().routeError).toBeNull()
})

it('leaves the initial root intact but canonicalizes a later return after subscribing', () => {
  useStore.setState({ appMode: 'canvas' })
  cleanup = installWorkbenchNavigation()
  expect(useStore.getState().appMode).toBe('image')
  expect(location.pathname).toBe('/')
  useStore.getState().setAppMode('library')
  popTo('/')
  expect(useStore.getState().appMode).toBe('image')
  expect(location.pathname).toBe('/')
})
it('canonicalizes the workbench static entry before syncing the workspace mode', () => {
  useStore.setState({ appMode: 'canvas' })
  history.replaceState(null, '', '/workbench.html?source=legacy#canvas')
  cleanup = installWorkbenchNavigation()
  expect(useStore.getState().appMode).toBe('image')
  expect(location.pathname).toBe('/')
  expect(location.search + location.hash).toBe('?source=legacy#canvas')
})

it('corrects an old address on same-project activation without adding history or losing the suffix', async () => {
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('Current')
  useCanvasProjectStore.setState({ projects: [project], activeId: project.id })
  history.replaceState(null, '', `/p/${project.id}?source=link#canvas`)
  const before = history.length
  useCanvasProjectStore.getState().activate(project.id)
  expect(location.pathname).toBe(`/p/${projectRouteSegment(project.id)}`)
  expect(location.search + location.hash).toBe('?source=link#canvas')
  expect(history.length).toBe(before)
})

it('sets canvas mode before resolving a history project and leaves library details only after success', async () => {
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('Destination')
  useStore.setState({ appMode: 'library', sidebarExpanded: false })
  useLibraryStore.setState({ onLibraryPage: true, detailTemplateId: 'detail' })
  history.replaceState(null, '', '/assets')
  cleanup = installWorkbenchNavigation()
  const resolve = useCanvasProjectStore.getState().resolve
  let release!: () => void
  vi.spyOn(useCanvasProjectStore.getState(), 'resolve').mockImplementationOnce(async (id) => {
    expect(useStore.getState().appMode).toBe('canvas')
    expect(useStore.getState().sidebarExpanded).toBeNull()
    await new Promise<void>((done) => {
      release = done
    })
    return resolve(id)
  })
  popTo(`/p/${project.id}`)
  await vi.waitFor(() => expect(release).toBeDefined())
  expect(useLibraryStore.getState().detailTemplateId).toBe('detail')
  release()
  await vi.waitFor(() => expect(useLibraryStore.getState().detailTemplateId).toBeNull())
  expect(useCanvasProjectStore.getState().activeId).toBe(project.id)
  await vi.waitFor(() => expect(useAgentStore.getState().loaded).toBe(true))
})

it.each([
  'refused',
  'thrown',
] as const)('keeps distinct address recovery when opening is %s', async (failure) => {
  setClientStorageScope(crypto.randomUUID())
  const active = await projectRepository.create('Current')
  const target = await projectRepository.create('Destination')
  useCanvasProjectStore.setState({ projects: [active, target], activeId: active.id, loaded: true })
  useLibraryStore.setState({ onLibraryPage: true, detailTemplateId: 'detail' })
  const select = vi.spyOn(useAgentStore.getState(), 'selectProject')
  if (failure === 'refused') select.mockResolvedValueOnce(false)
  else select.mockRejectedValueOnce(new Error('Cannot open'))
  history.replaceState(null, '', `/p/${target.id}?source=history#canvas`)
  const before = history.length
  cleanup = installWorkbenchNavigation()
  await vi.waitFor(() => {
    expect(select).toHaveBeenCalled()
    if (failure === 'refused')
      expect(location.pathname).toBe(`/p/${projectRouteSegment(active.id)}`)
    else expect(useCanvasProjectStore.getState().routeError).not.toBeNull()
  })
  if (failure === 'thrown') expect(location.pathname).toBe(`/p/${target.id}`)
  else expect(useCanvasProjectStore.getState().routeError).toBeNull()
  expect(location.search + location.hash).toBe('?source=history#canvas')
  expect(history.length).toBe(before)
  expect(useLibraryStore.getState().detailTemplateId).toBe('detail')
})

it.each([
  'leave',
  'dispose',
] as const)('invalidates a pending resolution on %s without cancelling its work', async (action) => {
  setClientStorageScope(crypto.randomUUID())
  const target = await projectRepository.create('Pending')
  let release!: () => void
  let resolved = false
  vi.spyOn(useCanvasProjectStore.getState(), 'resolve').mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      release = done
    })
    resolved = true
    return target
  })
  const select = vi.spyOn(useAgentStore.getState(), 'selectProject')
  useLibraryStore.setState({ onLibraryPage: true, detailTemplateId: 'detail' })
  history.replaceState(null, '', `/p/${target.id}`)
  cleanup = installWorkbenchNavigation()
  await vi.waitFor(() => expect(release).toBeDefined())
  if (action === 'dispose') {
    cleanup!()
    cleanup = undefined
    useStore.getState().setAppMode('tools')
    expect(location.pathname).toBe(`/p/${target.id}`)
    popTo('/privacy')
    expect(useStore.getState().appMode).toBe('tools')
  } else popTo('/assets')
  release()
  await vi.waitFor(() => expect(resolved).toBe(true))
  expect(select).not.toHaveBeenCalled()
  expect(useCanvasProjectStore.getState().activeId).toBeNull()
  expect(useCanvasProjectStore.getState().routeError).toBeNull()
  expect(useLibraryStore.getState().detailTemplateId).toBe('detail')
})

it.each([
  'opened',
  'refused',
  'thrown',
] as const)('ignores a late %s selection result after disposal', async (result) => {
  setClientStorageScope(crypto.randomUUID())
  const active = await projectRepository.create('Current')
  const target = await projectRepository.create('Pending')
  useCanvasProjectStore.setState({ projects: [active, target], activeId: active.id, loaded: true })
  useLibraryStore.setState({ onLibraryPage: true, detailTemplateId: 'detail' })
  let release!: () => void
  let finished = false
  vi.spyOn(useAgentStore.getState(), 'selectProject').mockImplementationOnce(
    async (_id, isCurrent) => {
      await new Promise<void>((done) => {
        release = done
      })
      expect(isCurrent?.()).toBe(false)
      finished = true
      if (result === 'thrown') throw new Error('Late failure')
      return result === 'opened'
    },
  )
  history.replaceState(null, '', `/p/${target.id}`)
  cleanup = installWorkbenchNavigation()
  await vi.waitFor(() => expect(release).toBeDefined())
  cleanup()
  cleanup = undefined
  release()
  await vi.waitFor(() => expect(finished).toBe(true))
  expect(useLibraryStore.getState().detailTemplateId).toBe('detail')
  expect(useCanvasProjectStore.getState().routeError).toBeNull()
  expect(location.pathname).toBe(`/p/${target.id}`)
})

describe('pathAppMode', () => {
  it('maps the canonical root and library addresses, folding legacy projects into library', () => {
    expect(pathAppMode('/')).toBe('image')
    expect(pathAppMode('/image')).toBeNull()
    expect(pathAppMode('/assets')).toBe('library')
    expect(pathAppMode('/projects/')).toBe('library')
    expect(pathAppMode('/p/abc')).toBeNull()
    expect(pathAppMode('/pricing')).toBeNull()
    expect(pathAppMode('/pricing/')).toBeNull()
    expect(isPricingPath('/pricing/')).toBe(true)
    expect(pathAppMode('/terms')).toBeNull()
    expect(isTermsPath('/terms/')).toBe(true)
    expect(isPrivacyPath('/privacy')).toBe(true)
  })
})

describe('installWorkbenchNavigation', () => {
  it('writes a history entry for each switch of the top-level pages', () => {
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    history.replaceState(null, '', `/p/${projectRouteSegment('project-1')}`)
    cleanup = installWorkbenchNavigation()
    const before = history.length

    useStore.getState().setAppMode('image')
    expect(location.pathname).toBe('/')
    useStore.getState().setAppMode('explore')
    expect(location.pathname).toBe('/explore')
    useStore.getState().setAppMode('canvas')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
    useStore.getState().setAppMode('library')
    expect(location.pathname).toBe('/assets')
    expect(history.length).toBe(before + 4)
  })

  it('follows back and forward to the page in the address', () => {
    cleanup = installWorkbenchNavigation()
    popTo('/projects')
    expect(useStore.getState().appMode).toBe('library')
    expect(useLibraryStore.getState().tab).toBe('projects')
    popTo('/assets')
    expect(useStore.getState().appMode).toBe('library')
    popTo('/')
    expect(useStore.getState().appMode).toBe('image')
  })

  it('keeps the pricing address when the workspace mode changes', () => {
    history.replaceState(null, '', '/pricing')
    cleanup = installWorkbenchNavigation()
    useStore.getState().setAppMode('explore')
    expect(location.pathname).toBe('/pricing')
  })

  it('keeps the terms address when the workspace mode changes', () => {
    history.replaceState(null, '', '/terms')
    cleanup = installWorkbenchNavigation()
    useStore.getState().setAppMode('explore')
    expect(location.pathname).toBe('/terms')
  })

  it('opens the page named by the address on load', () => {
    history.replaceState(null, '', '/assets')
    cleanup = installWorkbenchNavigation()
    expect(useStore.getState().appMode).toBe('library')
  })

  it('keeps the library address when the project catalog activates a project in the background', () => {
    history.replaceState(null, '', '/assets')
    cleanup = installWorkbenchNavigation()
    useCanvasProjectStore.setState({
      projects: [{ id: 'project-1' } as never],
    })
    useCanvasProjectStore.getState().activate('project-1', true)
    expect(location.pathname).toBe('/assets')
  })

  it('sends a bare root address to create, even with an active project', () => {
    useStore.setState({ appMode: 'library' })
    history.replaceState(null, '', '/assets')
    cleanup = installWorkbenchNavigation()
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    popTo('/')
    expect(useStore.getState().appMode).toBe('image')
    expect(location.pathname).toBe('/')
  })
})
