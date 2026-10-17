import {
  canvasOrigin,
  canvasText,
  createCanvasGroup,
  createCanvasUndoManager,
  insertCanvasNode,
  moveCanvasNodes,
  renameCanvasGroup,
  updateCanvasNode,
} from '@image-playground/shared'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  clearNodeCanvasSelection,
  nodeCanvasSelection,
  setNodeCanvasSelection,
  subscribeNodeCanvasSelection,
} from '../../../../features/canvas/lib/nodeCanvasSelection'

it('ignores geometry and unrelated edits while keeping selected references current', () => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'selection-test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => {} }
  const editor = { doc: new CanvasDoc() } as CanvasEditor
  for (const id of ['selected', 'other']) {
    insertCanvasNode(doc, {
      id, type: 'text', x: 0, y: 0, width: 300, height: 220, z: 0,
      data: { text: id, fontSize: 24, fill: '#fff' },
    }, origin)
  }
  let notifications = 0
  const unsubscribe = subscribeNodeCanvasSelection(() => { notifications++ })
  try {
    setNodeCanvasSelection(editor, canvas, ['selected'])
    notifications = 0
    moveCanvasNodes(doc, [{ id: 'selected', x: 100, y: 100 }], origin)
    updateCanvasNode(doc, 'other', { data: { text: 'unrelated', fontSize: 24, fill: '#fff' } }, origin)
    expect(notifications).toBe(0)
    doc.transact(() => {
      moveCanvasNodes(doc, [{ id: 'selected', x: 200, y: 100 }], origin)
      canvasText(doc, 'selected')!.insert(0, 'new title ')
    }, origin)
    expect(notifications).toBe(1)
    createCanvasGroup(doc, 'group', ['selected'], 'before', origin)
    setNodeCanvasSelection(editor, canvas, ['group'])
    notifications = 0
    renameCanvasGroup(doc, 'group', 'after', origin)
    expect(notifications).toBe(1)
    setNodeCanvasSelection(editor, canvas, ['selected'])
    notifications = 0
    doc.transact(() => doc.getMap('nodes').delete('selected'), origin)
    expect(notifications).toBe(1)
    expect(nodeCanvasSelection(editor)).toEqual([])
    clearNodeCanvasSelection(editor, canvas)
    notifications = 0
    renameCanvasGroup(doc, 'group', 'detached', origin)
    expect(notifications).toBe(0)
  } finally {
    clearNodeCanvasSelection(editor, canvas)
    unsubscribe()
    undo.destroy()
    doc.destroy()
  }
})
