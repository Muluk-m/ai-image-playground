import {
  canvasOrigin,
  createCanvasUndoManager,
  IMAGE_PRESETS,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { createImagePresetNode } from '../../../../features/canvas/lib/nodeImagePreset'

it('undoes preset preparation as one action and rejects missing or empty source nodes', () => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'preset-test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => {} }
  insertCanvasNode(
    doc,
    {
      id: 'source',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 320,
      data: { fileId: 'source-file' },
    },
    origin,
  )
  undo.stopCapturing()
  try {
    expect(createImagePresetNode(canvas, 'missing', IMAGE_PRESETS[0])).toBeUndefined()
    const id = createImagePresetNode(canvas, 'source', IMAGE_PRESETS[0])
    expect(readCanvasDocument(doc).edges).toEqual([
      expect.objectContaining({ source: 'source', target: id }),
    ])
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === id)?.data).toEqual({
      meta: { nodeKind: 'image', nodeImagePreset: 'character-sheet' },
    })
    undo.undo()
    expect(readCanvasDocument(doc).nodes.map((node) => node.id)).toEqual(['source'])
    expect(readCanvasDocument(doc).edges).toEqual([])
    insertCanvasNode(
      doc,
      {
        id: 'empty',
        type: 'image',
        x: 0,
        y: 500,
        width: 320,
        height: 320,
        data: {},
      },
      origin,
    )
    expect(createImagePresetNode(canvas, 'empty', IMAGE_PRESETS[0])).toBeUndefined()
  } finally {
    undo.destroy()
    doc.destroy()
  }
})
