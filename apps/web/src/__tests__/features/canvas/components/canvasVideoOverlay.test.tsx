// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanvasVideoOverlay from '../../../../features/canvas/components/CanvasVideoOverlay'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { recoverVideoPoster } from '../../../../features/canvas/lib/recoverVideoPoster'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

vi.mock('../../../../features/canvas/lib/recoverVideoPoster', () => ({
  recoverVideoPoster: vi.fn().mockResolvedValue(undefined),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PIXEL = 'data:image/png;base64,AQID'

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let editor: CanvasEditor

function addVideo(id: string): void {
  editor.placeImages([
    {
      id,
      dataUrl: PIXEL,
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      video: { taskId: 'task-2', outputIndex: 0 },
    },
  ])
}

function render(active = true): void {
  act(() => {
    root.render(<CanvasVideoOverlay editor={editor} active={active} />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('画布上的视频播放', () => {
  it('视频对象上给一个播放入口，点开就地播放', () => {
    addVideo('agent_video_1')
    render()

    const play = host.querySelector('button') as HTMLButtonElement
    expect(play).not.toBeNull()
    expect(host.querySelector('video')).toBeNull()

    act(() => play.click())

    const video = host.querySelector('video') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('http://bff.test/v1/queue/requests/task-2/output/0')
  })

  it('画布上没有视频时不渲染任何东西', () => {
    editor.placeImages([{ id: 'plain', dataUrl: PIXEL, x: 0, y: 0, width: 10, height: 10 }])
    render()

    expect(host.querySelector('button')).toBeNull()
  })

  it('视频对象被删掉时收起播放器', () => {
    addVideo('agent_video_1')
    render()
    act(() => (host.querySelector('button') as HTMLButtonElement).click())

    act(() => editor.deleteElement('agent_video_1'))

    expect(host.querySelector('video')).toBeNull()
  })
})

it('does not fetch covers in the hidden canvas and restores only visible video objects', () => {
  let intersect: (entries: { target: Element; isIntersecting: boolean }[]) => void = () => {}
  const observe = vi.fn()
  const unobserve = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect) {
        intersect = callback
      }
      observe = observe
      unobserve = unobserve
      disconnect = disconnect
    },
  )
  addVideo('visible')
  addVideo('offscreen')
  render(false)
  expect(observe).not.toHaveBeenCalled()
  expect(recoverVideoPoster).not.toHaveBeenCalled()
  render(true)
  const visible = host.querySelector('[data-video-object="visible"]')!
  const offscreen = host.querySelector('[data-video-object="offscreen"]')!
  expect(observe).toHaveBeenCalledTimes(2)
  act(() =>
    intersect([
      { target: visible, isIntersecting: true },
      { target: offscreen, isIntersecting: false },
    ]),
  )
  expect(recoverVideoPoster).toHaveBeenCalledExactlyOnceWith(editor, 'visible')
  expect(unobserve).toHaveBeenCalledWith(visible)
  render(false)
  expect(disconnect).toHaveBeenCalled()
  act(() => intersect([{ target: offscreen, isIntersecting: true }]))
  expect(recoverVideoPoster).toHaveBeenCalledTimes(1)
})
