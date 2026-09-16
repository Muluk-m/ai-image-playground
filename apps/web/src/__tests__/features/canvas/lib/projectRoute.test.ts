// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../../features/agent/store'
import { installProjectNavigation } from '../../../../features/canvas/lib/projectNavigation'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { readProjectRoute, writeProjectRoute } from '../../../../features/canvas/lib/projectRoute'
import { currentCanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
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

it('roundtrips legacy IDs without turning embedded slashes into route segments', () => {
  const id = 'legacy:canvas:user-a:conversation:会话/a'
  writeProjectRoute(id)
  expect(location.pathname).toBe(
    '/p/legacy%3Acanvas%3Auser-a%3Aconversation%3A%E4%BC%9A%E8%AF%9D%2Fa',
  )
  expect(readProjectRoute()).toBe(id)
  expect(readProjectRoute('/p/%FF')).toBeNull()
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
