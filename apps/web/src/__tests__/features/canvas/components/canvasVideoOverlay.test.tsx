// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CanvasVideoOverlay from '../../../../features/canvas/components/CanvasVideoOverlay'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { videoElementMeta } from '../../../../features/canvas/lib/videoElements'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

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
      meta: videoElementMeta({ taskId: 'task-2', outputIndex: 0 }),
    },
  ])
}

function render(): void {
  act(() => {
    root.render(<CanvasVideoOverlay editor={editor} />)
  })
}

beforeEach(() => {
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
