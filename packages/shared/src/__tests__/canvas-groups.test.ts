import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  canvasOrigin,
  createCanvasUndoManager,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
} from '../canvas-document'
import {
  createCanvasGroup,
  moveCanvasGroups,
  readCanvasGroups,
  reconcileCanvasGroupMembership,
  renameCanvasGroup,
  ungroupCanvasNodes,
} from '../canvas-groups'

const origin = canvasOrigin('user', 'group-test')
function fixture() {
  const doc = new Y.Doc()
  for (const [id, x] of [
    ['one', 0],
    ['two', 400],
    ['outside', 1000],
  ] as const)
    insertCanvasNode(
      doc,
      {
        id,
        type: 'text',
        x,
        y: 50,
        width: 300,
        height: 200,
        data: { text: id, fontSize: 16, fill: '#fff' },
      },
      origin,
    )
  return doc
}
it('groups selected nodes, moves them together and undoes without deleting content', () => {
  const doc = fixture(),
    undo = createCanvasUndoManager(doc, origin)
  createCanvasGroup(doc, 'scene', ['one', 'two'], '第一场', origin)
  const group = readCanvasGroups(doc)[0]!
  expect(group.members).toEqual(['one', 'two'])
  undo.stopCapturing()
  moveCanvasGroups(doc, [{ id: 'scene', x: group.x + 120, y: group.y + 80 }], origin)
  expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'two')).toMatchObject({
    x: 520,
    y: 130,
  })
  expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'outside')?.x).toBe(1000)
  undo.undo()
  expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'two')?.x).toBe(400)
  undo.stopCapturing()
  ungroupCanvasNodes(doc, ['scene'], origin)
  expect(readCanvasGroups(doc)).toHaveLength(0)
  expect(readCanvasDocument(doc).nodes).toHaveLength(3)
  undo.undo()
  expect(readCanvasGroups(doc)[0]?.name).toBe('第一场')
  undo.destroy()
  doc.destroy()
})
it('tracks drag in and out and merges a remote rename with a membership change', () => {
  const a = fixture()
  createCanvasGroup(a, 'scene', ['one', 'two'], '第一场', origin)
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  moveCanvasNodes(
    a,
    [
      { id: 'two', x: 1200, y: 50 },
      { id: 'outside', x: 350, y: 50 },
    ],
    origin,
  )
  reconcileCanvasGroupMembership(a, ['two', 'outside'], origin)
  renameCanvasGroup(b, 'scene', '海边', origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(readCanvasGroups(a)).toEqual(readCanvasGroups(b))
  expect(readCanvasGroups(a)[0]).toMatchObject({ name: '海边', members: ['one', 'outside'] })
  a.destroy()
  b.destroy()
})
