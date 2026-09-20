// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { projectRouteSegment } from '../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
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
  it('maps the image, projects and library addresses and leaves the rest to other routes', () => {
    expect(pathAppMode('/image')).toBe('image')
    expect(pathAppMode('/assets')).toBe('library')
    expect(pathAppMode('/projects/')).toBe('projects')
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
    useStore.getState().setAppMode('projects')
    expect(location.pathname).toBe('/projects')
    useStore.getState().setAppMode('canvas')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
    useStore.getState().setAppMode('library')
    expect(location.pathname).toBe('/assets')
    expect(history.length).toBe(before + 4)
  })

  it('follows back and forward to the page in the address', () => {
    cleanup = installAppRouting()
    popTo('/projects')
    expect(useStore.getState().appMode).toBe('projects')
    popTo('/assets')
    expect(useStore.getState().appMode).toBe('library')
    popTo('/')
    expect(useStore.getState().appMode).toBe('canvas')
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

  it('adds the active project to a bare root address without a new history entry', () => {
    useStore.setState({ appMode: 'library' })
    history.replaceState(null, '', '/assets')
    cleanup = installAppRouting()
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    popTo('/')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
  })
})
