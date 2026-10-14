import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  finishCanvasNodeJob,
  readCanvasDocument,
  setCanvasNodeJob,
  updateCanvasNode,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { createNode } from '../../../../features/canvas/lib/nodeCanvasActions'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import {
  addCanvasReference,
  CanvasReferenceLimitError,
  canPickCanvasReference,
  uploadCanvasReference,
} from '../../../../features/canvas/lib/nodeCanvasReferences'
import { API_MAX_IMAGES } from '../../../../lib/inputImageLimit'

const mock = vi.hoisted(() => ({ dimensions: vi.fn(async () => ({ width: 640, height: 360 })) }))
vi.mock('../../../../features/canvas/lib/importImages', () => ({
  fileToDataUrl: async () => 'data:image/png;base64,AA==',
}))
vi.mock('../../../../lib/canvasImage', () => ({ getImageDimensions: mock.dimensions }))
vi.mock('../../../../lib/authScope', () => ({ accountScope: () => () => true }))
function setup() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'reference-test')
  const canvas: NodeCanvasDocument = {
    doc,
    origin,
    undo: createCanvasUndoManager(doc, origin),
    destroy: async () => {
      doc.destroy()
    },
  }
  const target = createNode(canvas, 'video', { x: 0, y: 0 }, '')
  const source = createNode(canvas, 'image', { x: 1000, y: 0 }, '')
  updateCanvasNode(doc, source, { data: { fileId: 'source-file' } }, origin)
  canvas.undo.clear()
  return { canvas, target, source }
}
it('uses content and supported types, independent of left/right placement; rejects self, empty and unsupported nodes', () => {
  const { canvas, target, source } = setup()
  const video = createNode(canvas, 'video', { x: 0, y: 0 }, '')
  const empty = createNode(canvas, 'image', { x: 0, y: 0 }, '')
  const text = createNode(canvas, 'text', { x: 0, y: 0 }, '')
  const snapshot = readCanvasDocument(canvas.doc)
  expect(canPickCanvasReference(snapshot, target, source)).toBe(true)
  for (const id of [target, video, empty, text])
    expect(canPickCanvasReference(snapshot, target, id)).toBe(false)
  expect(addCanvasReference(canvas, target, source)).toBe(true)
  expect(addCanvasReference(canvas, target, source)).toBe(false)
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  canvas.doc.destroy()
})
it('adds a frame link and its slot in one undo step, and can reuse an already linked image', () => {
  const { canvas, target, source } = setup()
  expect(addCanvasReference(canvas, target, source, 'first')).toBe(true)
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === target)?.data).toMatchObject({
    meta: { videoFirstFrame: source },
  })
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
  expect(
    readCanvasDocument(canvas.doc).nodes.find((n) => n.id === target)?.data,
  ).not.toHaveProperty('meta.videoFirstFrame')
  addCanvasReference(canvas, target, source)
  expect(addCanvasReference(canvas, target, source, 'last')).toBe(true)
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  canvas.doc.destroy()
})
it('uploads append new linked cards without replacing source pixels and undo removes only the new reference', async () => {
  const { canvas, target, source } = setup()
  addCanvasReference(canvas, target, source)
  const editor = { doc: { cacheBitmap: vi.fn(() => 'uploaded-file') } } as unknown as CanvasEditor
  const id = await uploadCanvasReference(
    editor,
    canvas,
    target,
    new File(['x'], 'new.png', { type: 'image/png' }),
  )
  expect(id).toBeTruthy()
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(2)
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === source)?.data).toMatchObject({
    fileId: 'source-file',
  })
  canvas.undo.undo()
  expect(readCanvasDocument(canvas.doc).nodes.some((n) => n.id === id)).toBe(false)
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  canvas.doc.destroy()
})
it('does not insert a card if its target disappears while decoding', async () => {
  const { canvas, target } = setup()
  let done!: (size: { width: number; height: number }) => void
  mock.dimensions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve
      }),
  )
  const cacheBitmap = vi.fn()
  const promise = uploadCanvasReference(
    { doc: { cacheBitmap } } as unknown as CanvasEditor,
    canvas,
    target,
    new File(['x'], 'new.png', { type: 'image/png' }),
  )
  await Promise.resolve()
  deleteCanvasNode(canvas.doc, target, canvas.origin)
  done({ width: 640, height: 360 })
  expect(await promise).toBeNull()
  expect(cacheBitmap).not.toHaveBeenCalled()
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(1)
  canvas.doc.destroy()
})

it('does not persist projected loading state when selecting a frame during generation', () => {
  const { canvas, target, source } = setup()
  setCanvasNodeJob(
    canvas.doc,
    {
      id: 'job',
      nodeId: target,
      createdAt: 1,
      status: 'loading',
      message: '',
      meta: { prompt: '', clientRequestId: 'request' },
    },
    canvasOrigin('system', 'test'),
  )
  expect(readCanvasDocument(canvas.doc).nodes.find((n) => n.id === target)?.data).toHaveProperty(
    'pending',
  )
  addCanvasReference(canvas, target, source, 'first')
  finishCanvasNodeJob(canvas.doc, 'job', canvasOrigin('system', 'test'))
  expect(
    readCanvasDocument(canvas.doc).nodes.find((n) => n.id === target)?.data,
  ).not.toHaveProperty('pending')
  canvas.doc.destroy()
})
it('counts distinct image files rather than named assets or duplicate cards toward the image limit', async () => {
  const { canvas, target, source } = setup()
  for (let i = 0; i < API_MAX_IMAGES; i++) {
    const asset = createNode(canvas, 'image', { x: 0, y: 0 }, '')
    updateCanvasNode(
      canvas.doc,
      asset,
      { data: { name: 'Character', meta: { nodeKind: 'asset' } } },
      canvas.origin,
    )
    expect(addCanvasReference(canvas, target, asset)).toBe(true)
  }
  expect(addCanvasReference(canvas, target, source, 'first')).toBe(true)
  for (let i = 0; i < API_MAX_IMAGES; i++) {
    const duplicate = createNode(canvas, 'image', { x: 0, y: 0 }, '')
    updateCanvasNode(canvas.doc, duplicate, { data: { fileId: 'source-file' } }, canvas.origin)
    expect(addCanvasReference(canvas, target, duplicate)).toBe(true)
  }
  const editor = { doc: { cacheBitmap: vi.fn(() => 'uploaded-file') } } as unknown as CanvasEditor
  expect(
    await uploadCanvasReference(
      editor,
      canvas,
      target,
      new File(['x'], 'new.png', { type: 'image/png' }),
    ),
  ).toBeTruthy()
  canvas.doc.destroy()
})
it('reports the image limit without caching pixels or inserting an unlinked card', async () => {
  const { canvas, target } = setup()
  for (let i = 0; i < API_MAX_IMAGES; i++) {
    const id = createNode(canvas, 'image', { x: 0, y: 0 }, '')
    updateCanvasNode(canvas.doc, id, { data: { fileId: `file-${i}` } }, canvas.origin)
    connectCanvasNodes(canvas.doc, { source: id, target }, canvas.origin)
  }
  const before = readCanvasDocument(canvas.doc)
  const cacheBitmap = vi.fn()
  await expect(
    uploadCanvasReference(
      { doc: { cacheBitmap } } as unknown as CanvasEditor,
      canvas,
      target,
      new File(['x'], 'new.png', { type: 'image/png' }),
    ),
  ).rejects.toBeInstanceOf(CanvasReferenceLimitError)
  expect(cacheBitmap).not.toHaveBeenCalled()
  expect(readCanvasDocument(canvas.doc)).toEqual(before)
  canvas.doc.destroy()
})
