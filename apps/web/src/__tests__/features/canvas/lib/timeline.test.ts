import type { VideoGenerationRecord } from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { duplicateSelection } from '../../../../features/canvas/lib/canvasClipboard'
import { CanvasDoc, type TimelineEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  addSelectionToTimeline,
  clipSeconds,
  TIMELINE_PX_PER_SECOND,
  TIMELINE_UNKNOWN_SECONDS,
  timelineSegments,
} from '../../../../features/canvas/lib/timeline'

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast }) } }))

let doc: CanvasDoc
let editor: CanvasEditor

const record = (duration: number): VideoGenerationRecord => ({
  model: 'grok-imagine-video',
  duration,
  aspectRatio: '16:9',
  resolution: '720p',
})

function addVideo(id: string, x: number, duration?: number) {
  doc.addElements([
    {
      id,
      type: 'image',
      x,
      y: 0,
      width: 160,
      height: 90,
      rotation: 0,
      fileId: `file-${id}`,
      video: {
        taskId: `task-${id}`,
        outputIndex: 0,
        ...(duration ? { generation: record(duration) } : {}),
      },
    },
  ])
}

function timelines(): TimelineEl[] {
  return doc.elements.filter((el): el is TimelineEl => el.type === 'timeline')
}

beforeEach(() => {
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  showToast.mockClear()
})

describe('加入时间线', () => {
  it('creates one below the selected clips, ordered left to right', () => {
    addVideo('right', 400, 5)
    addVideo('left', 0, 8)
    editor.setSelectedElements(['right', 'left'])

    const id = addSelectionToTimeline(editor)

    const [timeline] = timelines()
    expect(timeline?.id).toBe(id)
    expect(timeline?.clips.map((clip) => clip.elementId)).toEqual(['left', 'right'])
    expect(timeline!.y).toBeGreaterThan(90)
    expect(editor.getSelectedIds()).toEqual([id])
  })

  it('appends to the timeline that is selected with the clips', () => {
    addVideo('a', 0, 5)
    editor.setSelectedElements(['a'])
    const id = addSelectionToTimeline(editor)!
    const widthBefore = timelines()[0]!.width
    addVideo('b', 600, 8)

    editor.setSelectedElements([id, 'b'])
    expect(addSelectionToTimeline(editor)).toBe(id)

    expect(timelines()).toHaveLength(1)
    expect(timelines()[0]!.clips.map((clip) => clip.elementId)).toEqual(['a', 'b'])
    expect(timelines()[0]!.width).toBeGreaterThan(widthBefore)
  })

  it('ignores a selection without videos', () => {
    doc.addElements([
      { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId: 'f' },
    ])
    editor.setSelectedElements(['img'])
    expect(addSelectionToTimeline(editor)).toBeNull()
    expect(timelines()).toHaveLength(0)
  })

  it('is one undo step', () => {
    addVideo('a', 0, 5)
    editor.setSelectedElements(['a'])
    addSelectionToTimeline(editor)
    doc.undo()
    expect(timelines()).toHaveLength(0)
    doc.redo()
    expect(timelines()).toHaveLength(1)
  })
})

describe('追加与上限', () => {
  it('undoes an append on its own, leaving the timeline as it was', () => {
    addVideo('a', 0, 5)
    editor.setSelectedElements(['a'])
    const id = addSelectionToTimeline(editor)!
    addVideo('b', 600, 8)
    editor.setSelectedElements([id, 'b'])
    addSelectionToTimeline(editor)

    doc.undo()

    expect(timelines()).toHaveLength(1)
    expect(timelines()[0]!.clips.map((clip) => clip.elementId)).toEqual(['a'])
  })

  it('appends to the only timeline on the canvas even when it is not selected', () => {
    addVideo('a', 0, 5)
    editor.setSelectedElements(['a'])
    const id = addSelectionToTimeline(editor)
    addVideo('b', 600, 8)
    editor.setSelectedElements(['b'])

    expect(addSelectionToTimeline(editor)).toBe(id)
    expect(timelines()).toHaveLength(1)
  })

  it('stops at the cloud limit and says so instead of breaking project sync', () => {
    const ids = Array.from({ length: 70 }, (_, index) => `v${index}`)
    ids.forEach((id, index) => addVideo(id, index * 200, 5))
    editor.setSelectedElements(ids)

    addSelectionToTimeline(editor)

    expect(timelines()[0]!.clips).toHaveLength(64)
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('points a duplicated timeline at the duplicated clips copied with it', () => {
    addVideo('a', 0, 5)
    editor.setSelectedElements(['a'])
    const id = addSelectionToTimeline(editor)!
    editor.setSelectedElements(['a', id])

    duplicateSelection(doc)

    const copy = timelines().find((one) => one.id !== id)!
    const copiedVideo = doc.elements.find((el) => el.type === 'image' && el.id !== 'a' && el.video)!
    expect(copy.clips[0]!.elementId).toBe(copiedVideo.id)
    expect(timelines().find((one) => one.id === id)!.clips[0]!.elementId).toBe('a')
  })
})

describe('片段', () => {
  it('keeps a known clip length after its source is deleted, so the film does not change', () => {
    addVideo('a', 0, 4)
    addVideo('b', 300, 8)
    editor.setSelectedElements(['a', 'b'])
    addSelectionToTimeline(editor)
    const lookup = (id: string) => doc.getElement(id)
    const before = timelineSegments(timelines()[0]!.clips, lookup)
    doc.deleteElements(['a'])
    const after = timelineSegments(timelines()[0]!.clips, lookup)
    expect(after.map((one) => [one.x, one.width, one.seconds])).toEqual(
      before.map((one) => [one.x, one.width, one.seconds]),
    )
  })

  it('keeps a deleted source as a missing segment instead of dropping it', () => {
    addVideo('a', 0, 5)
    addVideo('b', 300, 8)
    editor.setSelectedElements(['a', 'b'])
    addSelectionToTimeline(editor)
    doc.deleteElements(['a'])

    const segments = timelineSegments(timelines()[0]!.clips, (id) => doc.getElement(id))
    expect(segments.map((one) => [one.elementId, one.missing])).toEqual([
      ['a', true],
      ['b', false],
    ])
  })

  it('plays to the recorded end unless an out point is set, and assumes a length when unknown', () => {
    addVideo('known', 0, 8)
    addVideo('old', 0)
    expect(clipSeconds({ elementId: 'known', in: 1 }, doc.getElement('known'))).toBe(7)
    expect(clipSeconds({ elementId: 'known', in: 1, out: 4 }, doc.getElement('known'))).toBe(3)
    expect(clipSeconds({ elementId: 'old', in: 0 }, doc.getElement('old'))).toBe(
      TIMELINE_UNKNOWN_SECONDS,
    )
  })

  it('draws each segment as wide as it plays', () => {
    addVideo('a', 0, 5)
    const [segment] = timelineSegments([{ elementId: 'a', in: 0 }], (id) => doc.getElement(id))
    expect(segment!.width).toBe(5 * TIMELINE_PX_PER_SECOND)
  })
})
