import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  importLegacyElements,
  readCanvasDocument,
  reconcileLegacyElements,
} from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  changeNodeText,
  copyNodes,
  createNode,
  nodeKind,
  pasteNodes,
  removeNodes,
} from '../../../../features/canvas/lib/nodeCanvasActions'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'

function setup(): NodeCanvasDocument {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  const undo = createCanvasUndoManager(doc, origin)
  return {
    doc,
    origin,
    undo,
    async destroy() {
      undo.destroy()
      doc.destroy()
    },
  }
}
describe('node canvas editing transactions', () => {
  it('undoes creation and inline editing without a second editor history', () => {
    const canvas = setup()
    const id = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff')
    changeNodeText(canvas, id, 'A scene')
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.data).toMatchObject({ text: '' })
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(0)
    canvas.undo.redo()
    canvas.undo.redo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.data).toMatchObject({ text: 'A scene' })
  })
  it('copies a connected selection with new identities and preserves only internal links', () => {
    const canvas = setup()
    const a = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff'),
      b = createNode(canvas, 'image', { x: 500, y: 0 }, '#fff'),
      c = createNode(canvas, 'video', { x: 1000, y: 0 }, '#fff')
    connectCanvasNodes(canvas.doc, { source: a, target: b }, canvas.origin)
    connectCanvasNodes(canvas.doc, { source: b, target: c }, canvas.origin)
    const ids = pasteNodes(canvas, copyNodes(readCanvasDocument(canvas.doc), [a, b]), {
      x: 50,
      y: 500,
    })
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(a)
    expect(readCanvasDocument(canvas.doc).edges).toContainEqual(
      expect.objectContaining({ source: ids[0], target: ids[1] }),
    )
    expect(readCanvasDocument(canvas.doc).edges).toHaveLength(3)
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(3)
    expect(nodeKind(readCanvasDocument(canvas.doc).nodes[2]!)).toBe('video')
  })
  it('does not resurrect a deleted legacy node on reopen, and undo restores its links', () => {
    const canvas = setup()
    const legacy = [
      {
        id: 'old',
        type: 'text' as const,
        x: 0,
        y: 0,
        width: 300,
        height: 220,
        text: 'old',
        fontSize: 16,
        fill: '#fff',
      },
    ]
    importLegacyElements(canvas.doc, legacy, canvasOrigin('system', 'import'))
    const next = createNode(canvas, 'image', { x: 500, y: 0 }, '#fff')
    connectCanvasNodes(canvas.doc, { source: 'old', target: next }, canvas.origin)
    removeNodes(canvas, ['old'])
    reconcileLegacyElements(canvas.doc, legacy, canvasOrigin('system', 'reopen'))
    expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual([next])
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toContain('old')
    expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  })
  it('does not revive an undone new node from its later legacy bitmap', () => {
    const canvas = setup()
    const id = createNode(canvas, 'image', { x: 0, y: 0 }, '#fff')
    canvas.undo.undo()
    reconcileLegacyElements(
      canvas.doc,
      [{ id, type: 'image', x: 0, y: 0, width: 100, height: 100, rotation: 0, fileId: 'bitmap' }],
      canvasOrigin('system', 'reopen'),
    )
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(0)
    canvas.undo.redo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.id).toBe(id)
  })
})
