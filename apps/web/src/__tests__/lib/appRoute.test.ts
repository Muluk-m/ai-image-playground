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
  it('maps the image, video and works addresses and leaves the rest to other routes', () => {
    expect(pathAppMode('/image')).toBe('image')
    expect(pathAppMode('/works')).toBe('works')
    expect(pathAppMode('/video/')).toBe('video')
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
    useStore.getState().setAppMode('video')
    expect(location.pathname).toBe('/video')
    useStore.getState().setAppMode('canvas')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
    useStore.getState().setAppMode('works')
    expect(location.pathname).toBe('/works')
    expect(history.length).toBe(before + 4)
  })

  it('follows back and forward to the page in the address', () => {
    cleanup = installAppRouting()
    popTo('/video')
    expect(useStore.getState().appMode).toBe('video')
    popTo('/works')
    expect(useStore.getState().appMode).toBe('works')
    popTo('/')
    expect(useStore.getState().appMode).toBe('canvas')
  })

  it('opens the page named by the address on load', () => {
    history.replaceState(null, '', '/works')
    cleanup = installAppRouting()
    expect(useStore.getState().appMode).toBe('works')
  })

  it('keeps the works address when the project catalog activates a project in the background', () => {
    history.replaceState(null, '', '/works')
    cleanup = installAppRouting()
    useCanvasProjectStore.setState({
      projects: [{ id: 'project-1' } as never],
    })
    useCanvasProjectStore.getState().activate('project-1', true)
    expect(location.pathname).toBe('/works')
  })

  it('adds the active project to a bare root address without a new history entry', () => {
    useStore.setState({ appMode: 'works' })
    history.replaceState(null, '', '/works')
    cleanup = installAppRouting()
    useCanvasProjectStore.setState({ activeId: 'project-1' })
    popTo('/')
    expect(location.pathname).toBe(`/p/${projectRouteSegment('project-1')}`)
  })
})
