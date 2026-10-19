// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  readCanvasDocument,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { createNode } from '../../../../features/canvas/lib/nodeCanvasActions'
import { fillImageNode } from '../../../../features/canvas/lib/nodeCanvasGenerate'
import { nodeCardSize } from '@image-playground/shared'
import type * as CanvasImage from '../../../../lib/canvasImage'

const dimensions = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/canvasImage', async (original) => ({
  ...(await original<typeof CanvasImage>()),
  getImageDimensions: dimensions,
}))

it.each([
  { width: 2400, height: 800 },
  { width: 800, height: 2400 },
  { width: 32, height: 48 },
])('keeps empty, uploaded, replaced and restored cards at one size for $width × $height pixels', async (size) => {
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
      expect(nodeCardSize(readCanvasDocument(restored).nodes[0]!)).toEqual({
        width: 360,
        height: 240,
      })
    } finally {
      restored.destroy()
    }
    // Existing documents retain their authored geometry; only display geometry is standardized.
    updateCanvasNode(doc, id, { width: 520, height: 170 }, origin)
    await fillImageNode(editor, doc, id, new File(['third'], 'new.png', { type: 'image/png' }))
    expect(readCanvasDocument(doc).nodes[0]).toMatchObject({ width: 520, height: 170 })
    expect(nodeCardSize(readCanvasDocument(doc).nodes[0]!)).toEqual({ width: 360, height: 240 })
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
