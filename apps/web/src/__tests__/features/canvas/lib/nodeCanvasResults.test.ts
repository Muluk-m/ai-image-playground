import {
  canvasMainResult,
  canvasNodeJobs,
  canvasOrigin,
  canvasResults,
  createCanvasUndoManager,
  deleteCanvasNode,
  finishCanvasNodeJob,
  insertCanvasNode,
  readCanvasDocument,
  setCanvasNodeJob,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  adoptNodeResult,
  recordNodeOutput,
  selectNodeResult,
  spreadNodeResults,
} from '../../../../features/canvas/lib/nodeCanvasResults'
import { projectNodeVideoEdits } from '../../../../features/canvas/lib/nodeVideoTools'
import { timelineClipRange } from '../../../../features/canvas/lib/timelineRange'

const mocks = vi.hoisted(() => ({
  dimensions: vi.fn(async () => ({ width: 600, height: 400 })),
  fetch: vi.fn(),
  poster: vi.fn(async () => 'data:image/png;base64,poster'),
}))
vi.mock('../../../../features/agent/lib/videoPoster', () => ({ captureVideoPoster: mocks.poster }))
vi.mock('../../../../lib/canvasImage', () => ({ getImageDimensions: mocks.dimensions }))
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: mocks.fetch }))
vi.mock('../../../../lib/cloudMedia', () => ({
  resolveMediaSource: async (source: string) => source,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.dimensions.mockResolvedValue({ width: 600, height: 400 })
})
function fixture() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'results')
  const editor = new CanvasEditor(new CanvasDoc())
  const fileId = editor.doc.cacheBitmap('data:image/png;base64,old')
  insertCanvasNode(
    doc,
    { id: 'image', type: 'image', x: 0, y: 0, width: 300, height: 200, data: { fileId } },
    origin,
  )
  adoptNodeResult(doc, 'image')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = {
    doc,
    origin,
    undo,
    destroy: async () => {
      undo.destroy()
      doc.destroy()
    },
  }
  doc.on('update', () => projectNodeVideoEdits(editor, canvas))
  return { canvas, editor }
}
async function candidate(doc: Y.Doc, id: string, pixels?: string) {
  return (await recordNodeOutput(
    doc,
    {
      nodeId: 'image',
      kind: 'image',
      createdAt: 2,
      source: { type: 'queue', taskId: id, outputIndex: 0 },
    },
    pixels,
  ))!
}
it('switches the displayed main result and the legacy consumer, then undoes in one step', async () => {
  const { canvas, editor } = fixture()
  const old = canvasMainResult(canvas.doc, 'image')!
  const next = await candidate(canvas.doc, 'new', 'data:image/png;base64,new')
  await selectNodeResult(editor, canvas.doc, next.id, canvas.origin)
  const node = readCanvasDocument(canvas.doc).nodes[0]!
  expect(canvasMainResult(canvas.doc, 'image')?.id).toBe(next.id)
  expect(editor.doc.getElement('image')).toMatchObject({
    fileId: 'fileId' in node.data ? node.data.fileId : undefined,
  })
  canvas.undo.undo()
  expect(canvasMainResult(canvas.doc, 'image')?.id).toBe(old.id)
  await canvas.destroy()
})
it('keeps the main result unchanged on expiry and ignores a late decode after deletion', async () => {
  const { canvas, editor } = fixture()
  const old = canvasMainResult(canvas.doc, 'image')!.id
  const expired = await candidate(canvas.doc, 'expired')
  mocks.fetch.mockResolvedValue(new Response(null, { status: 410 }))
  await expect(selectNodeResult(editor, canvas.doc, expired.id, canvas.origin)).rejects.toThrow(
    'candidate_expired',
  )
  expect(canvasMainResult(canvas.doc, 'image')?.id).toBe(old)
  const late = await candidate(canvas.doc, 'late', 'data:image/png;base64,new')
  let finish!: (value: { width: number; height: number }) => void
  mocks.dimensions.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const selecting = selectNodeResult(editor, canvas.doc, late.id, canvas.origin)
  await vi.waitFor(() => expect(finish).toBeDefined())
  deleteCanvasNode(canvas.doc, 'image', canvas.origin)
  finish({ width: 10, height: 10 })
  expect(await selecting).toBe(false)
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(0)
  await canvas.destroy()
})
it('spreads candidates beside the source without overlap and removes all copies in one undo', async () => {
  const { canvas, editor } = fixture()
  await candidate(canvas.doc, 'second', 'data:image/png;base64,second')
  const ids = await spreadNodeResults(editor, canvas, 'image')
  expect(ids).toHaveLength(2)
  const nodes = readCanvasDocument(canvas.doc).nodes.filter((n) => ids.includes(n.id))
  expect(Math.abs(nodes[0]!.y - nodes[1]!.y)).toBeGreaterThanOrEqual(nodes[0]!.height + 96)
  for (const id of ids) expect(canvasResults(canvas.doc, id)).toHaveLength(1)
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual(['image'])
  expect(editor.doc.elements.map((element) => element.id)).toEqual(['image'])
  canvas.undo.redo()
  expect(editor.doc.elements.map((element) => element.id).sort()).toEqual(['image', ...ids].sort())
  await canvas.destroy()
})

it('does not restore a completed generation through the legacy projection', async () => {
  const { canvas, editor } = fixture()
  setCanvasNodeJob(
    canvas.doc,
    {
      id: 'job',
      nodeId: 'image',
      createdAt: 1,
      status: 'loading',
      message: '',
      meta: { nodeGeneration: true, prompt: 'test', clientRequestId: 'job' },
    },
    canvas.origin,
  )
  finishCanvasNodeJob(canvas.doc, 'job', canvas.origin)
  expect(editor.doc.getElement('image')).not.toHaveProperty('pending', expect.anything())
  const previous = editor.doc.elements
  editor.doc.updateElements([{ id: 'image', patch: { x: 30 } }])
  synchronizeLegacyElements(canvas.doc, previous, editor.doc.elements, canvas.origin)
  expect(canvasNodeJobs(canvas.doc)).toHaveLength(0)
  expect(readCanvasDocument(canvas.doc).nodes[0]!.data).not.toHaveProperty('pending')
  await canvas.destroy()
})
it('preserves a newer bitmap replacement while a candidate is decoding', async () => {
  const { canvas, editor } = fixture()
  const next = await candidate(canvas.doc, 'new', 'data:image/png;base64,new')
  let finish!: (value: { width: number; height: number }) => void
  mocks.dimensions.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const selecting = selectNodeResult(editor, canvas.doc, next.id, canvas.origin)
  await vi.waitFor(() => expect(finish).toBeDefined())
  updateCanvasNode(canvas.doc, 'image', { data: { fileId: 'manual-upload' } }, canvas.origin)
  finish({ width: 300, height: 200 })
  expect(await selecting).toBe(false)
  expect(canvasMainResult(canvas.doc, 'image')?.id).not.toBe(next.id)
  await canvas.destroy()
})
it('deduplicates outputs despite object-key order and adopts the same baseline across devices', async () => {
  const { canvas } = fixture()
  const other = new Y.Doc()
  Y.applyUpdate(other, Y.encodeStateAsUpdate(canvas.doc))
  other.getMap('mainResults').clear()
  adoptNodeResult(other, 'image')
  Y.applyUpdate(canvas.doc, Y.encodeStateAsUpdate(other))
  expect(canvasResults(canvas.doc, 'image')).toHaveLength(1)
  const first = await candidate(canvas.doc, 'same')
  const second = await recordNodeOutput(canvas.doc, {
    nodeId: 'image',
    kind: 'image',
    createdAt: 3,
    source: { outputIndex: 0, taskId: 'same', type: 'queue' },
  })
  expect(second?.id).toBe(first.id)
  other.destroy()
  await canvas.destroy()
})

it('bounds timeline playback to the current source without losing the original trim intent', () => {
  const clip = { in: 6, out: 10 }
  expect(timelineClipRange(clip, 5)).toEqual({ in: 4.9, out: 5 })
  expect(timelineClipRange(clip, 12)).toEqual(clip)
  expect(clip).toEqual({ in: 6, out: 10 })
})

it('selects a durable video after the queue task has expired', async () => {
  const { canvas, editor } = fixture()
  const next = await recordNodeOutput(canvas.doc, {
    nodeId: 'image',
    kind: 'video',
    createdAt: 2,
    source: { type: 'queue', taskId: 'expired', outputIndex: 0 },
    display: {
      video: { taskId: 'expired', outputIndex: 0, mediaId: '11111111-1111-4111-8111-111111111111' },
    },
  })
  expect(await selectNodeResult(editor, canvas.doc, next!.id, canvas.origin)).toBe(true)
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.poster).toHaveBeenCalledWith(
    expect.stringContaining('/api/media/11111111-1111-4111-8111-111111111111/content'),
  )
  expect(editor.doc.getElement('image')).toMatchObject({
    video: { mediaId: '11111111-1111-4111-8111-111111111111' },
  })
  await canvas.destroy()
})
