// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  deleteCanvasNode,
  importLegacyElements,
  readCanvasDocument,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { planFilm } from '../../../../features/canvas/lib/filmPlan'
import { copyNodes, pasteNodes } from '../../../../features/canvas/lib/nodeCanvasActions'
import {
  extractNodeVideoFrame,
  projectNodeVideoEdits,
  trimNodeVideo,
} from '../../../../features/canvas/lib/nodeVideoTools'
import { addSelectionToTimeline } from '../../../../features/canvas/lib/timeline'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('../../../../features/canvas/lib/canvasVideoActions', () => ({
  captureCanvasVideoFrame: capture,
}))
beforeEach(() => capture.mockReset().mockResolvedValue('data:image/png;base64,YQ=='))
function setup() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'tools')
  const editor = new CanvasEditor(new CanvasDoc())
  editor.placeImages([
    {
      id: 'video',
      dataUrl: 'data:image/png;base64,YQ==',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      naturalWidth: 1920,
      naturalHeight: 1080,
      video: { taskId: 'task', outputIndex: 0 },
    },
  ])
  editor.doc.addElements([
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 500,
      width: 500,
      height: 120,
      clips: [
        { elementId: 'video', in: 0, out: 10 },
        { elementId: 'video', in: 4, out: 6 },
      ],
    },
  ])
  importLegacyElements(doc, editor.doc.elements, canvasOrigin('system', 'fixture'))
  const canvas = {
    doc,
    origin,
    undo: createCanvasUndoManager(doc, origin),
    destroy: async () => doc.destroy(),
  }
  return { canvas, editor }
}
it('extracts the current playhead to a connected image and undoes it as one operation', async () => {
  const { canvas, editor } = setup()
  const id = await extractNodeVideoFrame(editor, canvas, 'video', 'current', 2.75)
  expect(capture).toHaveBeenCalledWith({ taskId: 'task', outputIndex: 0 }, 2.75)
  const snapshot = readCanvasDocument(canvas.doc),
    image = snapshot.nodes.find((n) => n.id === id)!
  expect(image.x).toBeGreaterThan(320)
  expect(image).toMatchObject({ width: 360, height: 240 })
  expect(image.data).toMatchObject({
    naturalWidth: 1920,
    naturalHeight: 1080,
    meta: { frameOf: 'video', frame: 'current' },
  })
  expect(snapshot.edges).toMatchObject([{ source: 'video', target: id }])
  const copy = copyNodes(snapshot, ['video', id!])
  const ids = pasteNodes(canvas, copy, { x: 1000, y: 0 })
  const pasted = readCanvasDocument(canvas.doc)
  expect(pasted.edges).toContainEqual(expect.objectContaining({ source: ids[0], target: ids[1] }))
  canvas.undo.undo()
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual(['video', 'timeline'])
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
})
it('does not resurrect a deleted source or create partial output on decode failure', async () => {
  const { canvas, editor } = setup()
  capture.mockResolvedValueOnce(null)
  await expect(extractNodeVideoFrame(editor, canvas, 'video', 'last')).rejects.toThrow()
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(2)
  capture.mockImplementationOnce(async () => {
    deleteCanvasNode(canvas.doc, 'video', canvas.origin)
    return 'data:image/png;base64,YQ=='
  })
  expect(await extractNodeVideoFrame(editor, canvas, 'video', 'first')).toBeNull()
  expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual(['timeline'])
})
it('trims all timeline references, persists range, and restores everything with one undo', () => {
  const { canvas, editor } = setup()
  canvas.doc.on('update', () => projectNodeVideoEdits(editor, canvas))
  expect(trimNodeVideo(canvas, 'video', 2, 8, 10)).toBe(true)
  const snap = readCanvasDocument(canvas.doc),
    timeline = snap.nodes.find((n) => n.type === 'timeline')!
  expect(timeline.data).toEqual({
    clips: [
      { elementId: 'video', in: 2, out: 8 },
      { elementId: 'video', in: 4, out: 6 },
    ],
  })
  expect(snap.nodes[0]!.data).toMatchObject({ meta: { videoTrimIn: '2', videoTrimOut: '8' } })
  if (timeline.type !== 'timeline') throw new Error('timeline')
  expect(planFilm(timeline.data.clips, (id) => editor.getElement(id))).toMatchObject({
    ok: true,
    clips: [
      { in: 2, out: 8 },
      { in: 4, out: 6 },
    ],
  })
  editor.setSelectedElements(['video'])
  addSelectionToTimeline(editor)
  expect(editor.getElement('timeline')).toMatchObject({
    clips: expect.arrayContaining([{ elementId: 'video', in: 2, out: 8 }]),
  })
  canvas.undo.undo()
  expect(editor.getElement('video')).toMatchObject({ meta: {} })
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === 'timeline')!.data).toEqual({
    clips: [
      { elementId: 'video', in: 0, out: 10 },
      { elementId: 'video', in: 4, out: 6 },
    ],
  })
  expect(trimNodeVideo(canvas, 'video', 8, 2, 10)).toBe(false)
  expect(trimNodeVideo(canvas, 'video', 0, 11, 10)).toBe(false)
  expect(trimNodeVideo(canvas, 'video', NaN, 5, 10)).toBe(false)
})

it('uses the same frame for portrait video extracts without overlapping the node below', async () => {
  const { canvas, editor } = setup()
  const { updateCanvasNode, insertCanvasNode } = await import('@image-playground/shared')
  updateCanvasNode(canvas.doc, 'video', { width: 180, height: 320 }, canvas.origin)
  insertCanvasNode(
    canvas.doc,
    { id: 'obstacle', type: 'image', x: 276, y: 400, width: 360, height: 240, data: {} },
    canvas.origin,
  )
  const id = await extractNodeVideoFrame(editor, canvas, 'video', 'first')
  const image = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)!
  expect(image).toMatchObject({ width: 360, height: 240 })
  expect(image.y + image.height <= 400 || image.y >= 640).toBe(true)
})

it('projects newly created timelines and posterless video sources into the shared preview/export editor', async () => {
  const { canvas, editor } = setup()
  const { insertCanvasNode } = await import('@image-playground/shared')
  insertCanvasNode(
    canvas.doc,
    {
      id: 'posterless',
      type: 'video',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { video: { taskId: 'posterless-task', outputIndex: 0 } },
    },
    canvas.origin,
  )
  insertCanvasNode(
    canvas.doc,
    {
      id: 'new-timeline',
      type: 'timeline',
      x: 0,
      y: 500,
      width: 560,
      height: 240,
      data: {
        clips: [
          { elementId: 'posterless', in: 0, out: 2 },
          { elementId: 'future', in: 0 },
        ],
      },
    },
    canvas.origin,
  )
  projectNodeVideoEdits(editor, canvas)
  expect(editor.getElement('new-timeline')).toMatchObject({
    type: 'timeline',
    clips: [
      { elementId: 'posterless', in: 0, out: 2 },
      { elementId: 'future', in: 0 },
    ],
  })
  expect(editor.getElement('posterless')).toMatchObject({
    type: 'image',
    video: { taskId: 'posterless-task' },
  })
  const el = editor.getElement('new-timeline')!
  if (el.type !== 'timeline') throw new Error('timeline')
  expect(planFilm(el.clips, (id) => editor.getElement(id))).toEqual({
    ok: false,
    refusal: { kind: 'missing', position: 2 },
  })
})
