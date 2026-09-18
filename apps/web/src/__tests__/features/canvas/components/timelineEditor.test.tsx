// @vitest-environment jsdom
import type { VideoGenerationRecord } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelineEditorHost from '../../../../features/canvas/components/TimelineEditor'
import { CanvasDoc, type TimelineEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { useTimelineEditor } from '../../../../features/canvas/timelineEditorStore'

vi.mock('../../../../lib/cloudMedia', () => ({
  resolveMediaSource: async (source: string) => source,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let editor: CanvasEditor

const record = (duration: number): VideoGenerationRecord => ({
  model: 'grok-imagine-video',
  duration,
  aspectRatio: '16:9',
  resolution: '720p',
})

function addVideo(id: string, duration: number) {
  doc.addElements([
    {
      id,
      type: 'image',
      x: 0,
      y: 0,
      width: 160,
      height: 90,
      rotation: 0,
      fileId: `file-${id}`,
      video: { taskId: `task-${id}`, outputIndex: 0, generation: record(duration) },
    },
  ])
}

function timeline(): TimelineEl {
  return doc.getElement('tl') as TimelineEl
}

function order() {
  return timeline().clips.map((clip) => clip.elementId)
}

function button(label: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (one) => one.getAttribute('aria-label') === label,
  ) as HTMLButtonElement
}

function render() {
  act(() => root.render(<TimelineEditorHost editor={editor} />))
}

beforeEach(() => {
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  addVideo('a', 4)
  addVideo('b', 6)
  addVideo('c', 8)
  doc.addElements([
    {
      id: 'tl',
      type: 'timeline',
      x: 0,
      y: 300,
      width: 400,
      height: 120,
      clips: [
        { elementId: 'a', in: 0, out: 4 },
        { elementId: 'b', in: 0, out: 6 },
        { elementId: 'c', in: 0, out: 8 },
      ],
    },
  ])
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => useTimelineEditor.getState().open('tl'))
  render()
})

afterEach(() => {
  act(() => useTimelineEditor.getState().close())
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('全屏时间线编辑', () => {
  it('shows every clip and the total length', () => {
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('0:18.0')
    expect(document.querySelectorAll('ol li')).toHaveLength(3)
  })

  it('writes the edits back on close as a single undo step', () => {
    act(() => button('删除第 2 段').click())
    act(() => button('删除第 1 段').click())
    expect(order()).toEqual(['a', 'b', 'c'])

    act(() => button('完成').click())

    expect(order()).toEqual(['c'])
    expect(useTimelineEditor.getState().openId).toBeNull()
    doc.undo()
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  it('reorders by dragging a clip onto another', () => {
    const cards = () => Array.from(document.querySelectorAll('ol li'))
    act(() => {
      cards()[2]!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    })
    act(() => {
      cards()[0]!.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    act(() => button('完成').click())
    expect(order()).toEqual(['c', 'a', 'b'])
  })

  it('trims with the keyboard and never below half a second', () => {
    const outPoint = document.querySelector('[aria-label="第 1 段出点"]') as HTMLElement
    for (let i = 0; i < 60; i += 1)
      act(() => {
        outPoint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      })
    act(() => button('完成').click())
    expect(timeline().clips[0]).toEqual({ elementId: 'a', in: 0, out: 0.5 })
  })

  it('leaves the canvas untouched when nothing changed', () => {
    const before = doc.elements
    act(() => button('完成').click())
    expect(doc.elements).toBe(before)
  })
})
