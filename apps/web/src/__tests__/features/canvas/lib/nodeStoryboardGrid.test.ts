// @vitest-environment jsdom
import {
  canvasInputFingerprint,
  canvasMainResult,
  canvasOrigin,
  canvasResultIsStale,
  canvasResults,
  chooseCanvasResult,
  createCanvasUndoManager,
  insertCanvasNode,
  promoteCanvasResultMedia,
  readCanvasDocument,
  recordCanvasResult,
  storyboardFingerprint,
  updateCanvasNode,
  updateStoryboardShot,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { prepareStoryboardFrames } from '../../../../features/canvas/lib/nodeStoryboardFlow'
import {
  splitStoryboardGrid,
  storyboardTiles,
} from '../../../../features/canvas/lib/nodeStoryboardGrid'

const mocks = vi.hoisted(() => ({ encode: vi.fn(async () => new Blob(['tile'])), draw: vi.fn() }))
vi.mock('../../../../lib/canvasImage', () => ({
  loadImage: async () => ({ naturalWidth: 301, naturalHeight: 201 }),
  canvasToBlob: mocks.encode,
}))
vi.mock('../../../../lib/cloudMedia', () => ({
  resolveMediaSource: async (s: string) => s,
  blobDataUrl: async () => 'data:image/png;base64,tile',
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.encode.mockResolvedValue(new Blob(['tile']))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: mocks.draw,
  } as unknown as CanvasRenderingContext2D)
})
function setup() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  const canvas = {
      doc,
      origin,
      undo,
      destroy: async () => {
        undo.destroy()
        doc.destroy()
      },
    },
    editor = new CanvasEditor(new CanvasDoc())
  const shots = Array.from({ length: 3 }, (_, i) => ({
    id: `s${i}`,
    description: `Scene ${i}`,
    lookIds: [],
  }))
  insertCanvasNode(
    doc,
    {
      id: 'board',
      type: 'storyboard',
      x: 0,
      y: 0,
      width: 600,
      height: 340,
      data: {
        shots,
        confirmed: { fingerprint: storyboardFingerprint(shots), model: 'test', quantity: 3 },
      },
    },
    origin,
  )
  const { frameIds, generateIds } = prepareStoryboardFrames(canvas, 'board', 'grid'),
    gridId = generateIds[0]!
  const result = {
    id: 'grid-result',
    nodeId: gridId,
    kind: 'image' as const,
    createdAt: 1,
    source: { type: 'file' as const, fileId: editor.doc.cacheBitmap('grid-pixels') },
    inputFingerprint: canvasInputFingerprint(doc, gridId),
  }
  recordCanvasResult(doc, result, origin)
  chooseCanvasResult(doc, gridId, result.id, { data: { fileId: result.source.fileId } }, origin)
  return { canvas, editor, frameIds, gridId }
}
it('cuts every pixel in reading order and rejects invalid layouts', () => {
  expect(storyboardTiles(301, 201, 2, 2, 4)).toEqual([
    { x: 0, y: 0, width: 150, height: 100 },
    { x: 150, y: 0, width: 151, height: 100 },
    { x: 0, y: 100, width: 150, height: 101 },
    { x: 150, y: 100, width: 151, height: 101 },
  ])
  for (const count of [-1, NaN, 0, 5])
    expect(() => storyboardTiles(301, 201, 2, 2, count)).toThrow()
})
it('splits a completed sheet into existing first frames once, preserving the source result', async () => {
  const { canvas, editor, frameIds, gridId } = setup()
  expect(await splitStoryboardGrid(canvas, editor, gridId)).toBe(true)
  for (const [index, id] of frameIds.entries())
    expect(canvasMainResult(canvas.doc, id)?.source).toEqual({
      type: 'file',
      fileId: `story-grid:grid-result:${index}`,
    })
  expect(canvasMainResult(canvas.doc, gridId)?.id).toBe('grid-result')
  expect(mocks.draw.mock.calls.map((call) => call.slice(1, 5))).toEqual([
    [0, 0, 150, 100],
    [150, 0, 151, 100],
    [0, 100, 150, 101],
  ])
  expect(await splitStoryboardGrid(canvas, editor, gridId)).toBe(false)
  expect(canvasResults(canvas.doc)).toHaveLength(4)
})
it('retains a user-picked frame while adding the cut as an alternate candidate', async () => {
  const { canvas, editor, frameIds, gridId } = setup()
  let release!: (blob: Blob) => void
  mocks.encode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = splitStoryboardGrid(canvas, editor, gridId)
  await vi.waitFor(() => expect(mocks.encode).toHaveBeenCalledTimes(1))
  const id = frameIds[0]!
  recordCanvasResult(
    canvas.doc,
    {
      id: 'manual',
      nodeId: id,
      kind: 'image',
      createdAt: 2,
      source: { type: 'file', fileId: 'manual' },
    },
    canvas.origin,
  )
  chooseCanvasResult(canvas.doc, id, 'manual', { data: { fileId: 'manual' } }, canvas.origin)
  release(new Blob(['tile']))
  expect(await pending).toBe(true)
  expect(canvasMainResult(canvas.doc, id)?.id).toBe('manual')
  expect(canvasResults(canvas.doc, id)).toHaveLength(2)
})
it('abandons a sheet if its reviewed storyboard changes while pixels are being encoded', async () => {
  const { canvas, editor, frameIds, gridId } = setup()
  let release!: (blob: Blob) => void
  mocks.encode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = splitStoryboardGrid(canvas, editor, gridId)
  await vi.waitFor(() => expect(mocks.encode).toHaveBeenCalledTimes(1))
  updateStoryboardShot(canvas.doc, 'board', 's0', { description: 'changed scene' }, canvas.origin)
  release(new Blob(['tile']))
  expect(await pending).toBe(false)
  expect(frameIds.every((id) => !canvasMainResult(canvas.doc, id))).toBe(true)
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(5)
})

it('keeps the prepared input identity when a frame was edited during generation', async () => {
  const { canvas, editor, frameIds, gridId } = setup(),
    id = frameIds[0]!
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)!
  if (node.type === 'image')
    updateCanvasNode(
      canvas.doc,
      id,
      { data: { ...node.data, meta: { ...node.data.meta, nodePrompt: 'new direction' } } },
      canvas.origin,
    )
  expect(await splitStoryboardGrid(canvas, editor, gridId)).toBe(true)
  expect(canvasMainResult(canvas.doc, id)).toBeUndefined()
  const candidate = canvasResults(canvas.doc, id)[0]!
  expect(candidate.inputFingerprint).not.toBe(canvasInputFingerprint(canvas.doc, id))
})
it('recognizes the previous cuts after cloud promotion and accepts a new contact-sheet candidate', async () => {
  const { canvas, editor, frameIds, gridId } = setup()
  await splitStoryboardGrid(canvas, editor, gridId)
  for (const id of frameIds) {
    const result = canvasMainResult(canvas.doc, id)!
    promoteCanvasResultMedia(
      canvas.doc,
      id,
      result.source.type === 'file' ? result.source.fileId : '',
      '11111111-1111-4111-8111-111111111111',
      canvas.origin,
    )
  }
  const next = {
    id: 'grid-next',
    nodeId: gridId,
    kind: 'image' as const,
    createdAt: 2,
    source: { type: 'file' as const, fileId: editor.doc.cacheBitmap('next-grid') },
    inputFingerprint: canvasInputFingerprint(canvas.doc, gridId),
  }
  recordCanvasResult(canvas.doc, next, canvas.origin)
  chooseCanvasResult(
    canvas.doc,
    gridId,
    next.id,
    { data: { fileId: next.source.fileId } },
    canvas.origin,
  )
  expect(await splitStoryboardGrid(canvas, editor, gridId)).toBe(true)
  for (const [index, id] of frameIds.entries()) {
    expect(canvasMainResult(canvas.doc, id)?.source).toEqual({
      type: 'file',
      fileId: `story-grid:grid-next:${index}`,
    })
    expect(canvasResultIsStale(canvas.doc, id)).toBe(false)
  }
})
