// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../../features/agent/store'
import { currentCanvasWorkspace } from '../../../../features/canvas/lib/activeProject'
import { installProjectNavigation } from '../../../../features/canvas/lib/projectNavigation'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import {
  projectRouteSegment,
  readProjectRoute,
  resolveProjectRoute,
  writeProjectRoute,
} from '../../../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import {
  CANVAS_PROJECT_KEY,
  scopedStorageName,
  setClientStorageScope,
} from '../../../../lib/authScope'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  history.replaceState(null, '', '/')
  setClientStorageScope(null)
  useCanvasProjectStore.setState({ loaded: false, projects: [], activeId: null, routeError: null })
})

it('shortens legacy addresses without changing their persistent IDs and accepts old links', () => {
  const id = 'legacy:canvas:user-a:conversation:会话/a'
  writeProjectRoute(id)
  expect(location.pathname).toMatch(/^\/p\/[a-z0-9]{14}$/)
  expect(resolveProjectRoute(readProjectRoute()!, [{ id }])).toBe(id)
  expect(readProjectRoute(`/p/${encodeURIComponent(id)}`)).toBe(id)
  expect(readProjectRoute('/p/%FF')).toBeNull()
})

it('UUID addresses are short and reversible without a loaded catalog', () => {
  const id = '074725ca-5580-4a75-9baa-fcadd050e1c1'
  writeProjectRoute(id)
  expect(location.pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{22}$/)
  expect(readProjectRoute()).toBe(id)
  expect(readProjectRoute(`/p/${id}`)).toBe(id)
})

it('reload resolves a short legacy address and rewrites the old escaped address', async () => {
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('Legacy', {
    sceneKey: `canvas:test:${crypto.randomUUID()}`,
    conversationId: null,
  })
  history.replaceState(null, '', `/p/${projectRouteSegment(project.id)}`)
  await useCanvasProjectStore.getState().load()
  expect(useCanvasProjectStore.getState().activeId).toBe(project.id)
  expect((await useCanvasProjectStore.getState().resolve(projectRouteSegment(project.id))).id).toBe(
    project.id,
  )
  useCanvasProjectStore.setState({ loaded: false, projects: [], activeId: null })
  history.replaceState(null, '', `/p/${encodeURIComponent(project.id)}`)
  await useCanvasProjectStore.getState().load()
  expect(location.pathname).toBe(`/p/${projectRouteSegment(project.id)}`)
  expect(useCanvasProjectStore.getState().activeId).toBe(project.id)
})

it('reload restores the URL project over the last selection, and back/forward switches the actual workspace', async () => {
  setClientStorageScope(crypto.randomUUID())
  const a = await projectRepository.create('A'),
    b = await projectRepository.create('B')
  localStorage.setItem(scopedStorageName(CANVAS_PROJECT_KEY), b.id)
  history.replaceState(null, '', `/p/${a.id}`)
  cleanup = installProjectNavigation()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(a.id))
  await vi.waitFor(() => expect(useAgentStore.getState().loaded).toBe(true))
  expect(await useAgentStore.getState().selectProject(b.id)).toBe(true)
  expect(readProjectRoute()).toBe(b.id)
  history.back()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(a.id))
  expect(readProjectRoute()).toBe(a.id)
  history.forward()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(b.id))
  expect(readProjectRoute()).toBe(b.id)
})

it('an unknown project URL never silently opens a different remembered project', async () => {
  setClientStorageScope(crypto.randomUUID())
  const existing = await projectRepository.create('Existing')
  localStorage.setItem(scopedStorageName(CANVAS_PROJECT_KEY), existing.id)
  history.replaceState(null, '', '/p/missing-project')
  cleanup = installProjectNavigation()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().routeError).not.toBeNull())
  expect(useCanvasProjectStore.getState().activeId).toBeNull()
  expect(readProjectRoute()).toBe('missing-project')
})

it('rapid history changes finish at the last requested project while a save is pending', async () => {
  setClientStorageScope(crypto.randomUUID())
  const a = await projectRepository.create('A'),
    b = await projectRepository.create('B'),
    c = await projectRepository.create('C')
  history.replaceState(null, '', `/p/${a.id}`)
  cleanup = installProjectNavigation()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(a.id))
  await vi.waitFor(() => expect(useAgentStore.getState().loaded).toBe(true))
  let release!: (saved: boolean) => void
  const save = vi.spyOn(currentCanvasWorkspace(), 'flush').mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve
      }),
  )
  history.pushState(null, '', `/p/${b.id}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  await vi.waitFor(() => expect(release).toBeDefined())
  history.pushState(null, '', `/p/${c.id}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  release(true)
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(c.id))
  expect(readProjectRoute()).toBe(c.id)
  save.mockRestore()
})

it('legacy navigation continues opening the workspace after canonicalizing an old URL', async () => {
  setClientStorageScope(crypto.randomUUID())
  const a = await projectRepository.create('A')
  const b = await projectRepository.create('Legacy', {
    sceneKey: `canvas:test:${crypto.randomUUID()}`,
    conversationId: null,
  })
  history.replaceState(null, '', `/p/${a.id}`)
  cleanup = installProjectNavigation()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(a.id))
  await vi.waitFor(() => expect(useAgentStore.getState().loaded).toBe(true))
  history.pushState(null, '', `/p/${encodeURIComponent(b.id)}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(b.id))
  expect(location.pathname).toBe(`/p/${projectRouteSegment(b.id)}`)
  history.back()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(a.id))
  history.forward()
  await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).toBe(b.id))
})
