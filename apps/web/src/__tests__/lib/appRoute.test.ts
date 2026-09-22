// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { projectRouteSegment } from '../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { useLibraryStore } from '../../features/library/store'
import { pathAppMode } from '../../lib/appPaths'
import { installAppRouting } from '../../lib/appRoute'
import { useStore } from '../../store'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  history.replaceState(null, '', '/')
  useStore.setState({ appMode: 'canvas' })
  useCanvasProjectStore.setState({ projects: [], activeId: null })
})

function popTo(path: string) {
  history.replaceState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

describe('pathAppMode', () => {
  it('maps the image and library addresses, folds the legacy projects address into library, and leaves the rest to other routes', () => {
    expect(pathAppMode('/image')).toBe('image')
    expect(pathAppMode('/assets')).toBe('library')
    expect(pathAppMode('/projects/')).toBe('library')
    expect(pathAppMode('/')).toBeNull()
    expect(pathAppMode('/p/abc')).toBeNull()
  })
})

describe('installAppRouting', () => {
  it('writes a history entry for each switch of the top-level pages', () => {
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    history.replaceState(null, '', `/p/${projectRouteSegment('project-1')}`)
    cleanup = installAppRouting()
    const before = history.length

    useStore.getState().setAppMode('image')
    expect(location.pathname).toBe('/image')
    useStore.getState().setAppMode('explore')
    expect(location.pathname).toBe('/explore')
    useStore.getState().setAppMode('canvas')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
    useStore.getState().setAppMode('library')
    expect(location.pathname).toBe('/assets')
    expect(history.length).toBe(before + 4)
  })

  it('follows back and forward to the page in the address', () => {
    cleanup = installAppRouting()
    popTo('/projects')
    expect(useStore.getState().appMode).toBe('library')
    expect(useLibraryStore.getState().tab).toBe('projects')
    popTo('/assets')
    expect(useStore.getState().appMode).toBe('library')
    popTo('/')
    expect(useStore.getState().appMode).toBe('image')
  })

  it('opens the page named by the address on load', () => {
    history.replaceState(null, '', '/assets')
    cleanup = installAppRouting()
    expect(useStore.getState().appMode).toBe('library')
  })

  it('keeps the library address when the project catalog activates a project in the background', () => {
    history.replaceState(null, '', '/assets')
    cleanup = installAppRouting()
    useCanvasProjectStore.setState({
      projects: [{ id: 'project-1' } as never],
    })
    useCanvasProjectStore.getState().activate('project-1', true)
    expect(location.pathname).toBe('/assets')
  })

  it('sends a bare root address to create, even with an active project', () => {
    useStore.setState({ appMode: 'library' })
    history.replaceState(null, '', '/assets')
    cleanup = installAppRouting()
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    popTo('/')
    expect(useStore.getState().appMode).toBe('image')
    expect(location.pathname).toBe('/image')
  })
})
