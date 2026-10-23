// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  nodeCardSize,
  readCanvasDocument,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { createNode } from '../../../../features/canvas/lib/nodeCanvasActions'
import {
  fillImageNode,
  InvalidImageFileError,
  readImageFile,
} from '../../../../features/canvas/lib/nodeCanvasGenerate'
import type * as CanvasImage from '../../../../lib/canvasImage'

const dimensions = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/canvasImage', async (original) => ({
  ...(await original<typeof CanvasImage>()),
  getImageDimensions: dimensions,
}))

const displaySize = (width: number, height: number) => {
  const scale = Math.min(1, 360 / width, 240 / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

it.each([
  { width: 2400, height: 800 },
  { width: 800, height: 2400 },
  { width: 32, height: 48 },
])('keeps authored geometry while display size follows $width × $height pixels', async (size) => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'media-test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => doc.destroy() }
  const editor = new CanvasEditor(new CanvasDoc())
  let previous = editor.doc.elements
  const unsubscribe = editor.doc.subscribe(() => {
    const next = editor.doc.elements
    synchronizeLegacyElements(doc, previous, next, origin)
    previous = next
  })
  try {
    dimensions.mockResolvedValue(size)
    const id = createNode(canvas, 'image', { x: 400, y: 300 }, '')
    const bounds = { x: 220, y: 180, width: 360, height: 240 }
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject(bounds)
    await fillImageNode(editor, doc, id, new File(['first'], 'portrait.png', { type: 'image/png' }))
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
      ...bounds,
      data: { naturalWidth: size.width, naturalHeight: size.height, name: 'portrait.png' },
    })
    dimensions.mockResolvedValue({ width: size.height, height: size.width })
    await fillImageNode(
      editor,
      doc,
      id,
      new File(['second'], 'landscape.png', { type: 'image/png' }),
    )
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
      ...bounds,
      data: { naturalWidth: size.height, naturalHeight: size.width, name: 'landscape.png' },
    })
    expect(editor.doc.getElement(id)).toMatchObject(bounds)
    const restored = new Y.Doc()
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc))
      expect(readCanvasDocument(restored).nodes[0]).toMatchObject(bounds)
      expect(nodeCardSize(readCanvasDocument(restored).nodes[0]!)).toEqual(
        displaySize(size.height, size.width),
      )
    } finally {
      restored.destroy()
    }
    // Existing documents retain their authored geometry; display geometry follows the source ratio.
    updateCanvasNode(doc, id, { width: 520, height: 170 }, origin)
    await fillImageNode(editor, doc, id, new File(['third'], 'new.png', { type: 'image/png' }))
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({ width: 520, height: 170 })
    expect(nodeCardSize(readCanvasDocument(doc).nodes[0]!)).toEqual(
      displaySize(size.height, size.width),
    )
    const video = createNode(canvas, 'video', { x: 1000, y: 300 }, '')
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === video)).toMatchObject({
      width: 360,
      height: 240,
    })
  } finally {
    unsubscribe()
    undo.destroy()
    doc.destroy()
  }
})

it.each([
  ['a 0-byte file', new File([], 'zero.png', { type: 'image/png' }), undefined],
  ['text renamed to .png', new File(['hello'], 'fake.png', { type: 'image/png' }), 'reject'],
  [
    'an image without pixels',
    new File(['x'], 'empty.png', { type: 'image/png' }),
    { width: 0, height: 0 },
  ],
] as const)('rejects %s before anything reaches the canvas', async (_label, file, decoded) => {
  dimensions.mockReset()
  if (decoded === 'reject') dimensions.mockRejectedValue(new Error('decode'))
  else if (decoded) dimensions.mockResolvedValue(decoded)
  await expect(readImageFile(file)).rejects.toBeInstanceOf(InvalidImageFileError)
  await expect(readImageFile(file)).rejects.toMatchObject({ fileName: file.name })
})

it('reads a File from another window even though it fails this window’s instanceof File', async () => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'media-test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => doc.destroy() }
  const editor = new CanvasEditor(new CanvasDoc())
  let previous = editor.doc.elements
  const unsubscribe = editor.doc.subscribe(() => {
    const next = editor.doc.elements
    synchronizeLegacyElements(doc, previous, next, origin)
    previous = next
  })
  try {
    dimensions.mockReset()
    dimensions.mockResolvedValue({ width: 640, height: 480 })
    const id = createNode(canvas, 'image', { x: 400, y: 300 }, '')
    // 跨 window 的 File：原型链不在本窗口，结构上仍是带 name 的 Blob。
    const foreign = Object.assign(new Blob(['pixels'], { type: 'image/png' }), {
      name: 'other-window.png',
      lastModified: 0,
    }) as unknown as File
    expect(foreign instanceof File).toBe(false)
    await fillImageNode(editor, doc, id, foreign)
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
      data: { naturalWidth: 640, naturalHeight: 480, name: 'other-window.png' },
    })
  } finally {
    unsubscribe()
    undo.destroy()
    doc.destroy()
  }
})
