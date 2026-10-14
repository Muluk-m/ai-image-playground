import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import { canvasOrigin, createCanvasUndoManager, insertCanvasNode } from '../canvas-document'
import {
  publishCanvasUndoLineage,
  restoreCanvasUndoLineage,
  validateCanvasUndoLineage,
} from '../canvas-undo-lineage'

it('publishes only changed undo pointers and rejects malformed synced lineage', () => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'test')
  const undo = createCanvasUndoManager(doc, origin)
  insertCanvasNode(
    doc,
    {
      id: 'one',
      type: 'text',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { text: 'one', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  undo.undo()
  undo.redo()
  publishCanvasUndoLineage(doc)
  expect(doc.getMap('undoLineage').size).toBeGreaterThan(0)
  const vector = Y.encodeStateVector(doc)
  publishCanvasUndoLineage(doc)
  expect(Y.encodeStateVector(doc)).toEqual(vector)
  doc.getMap('undoLineage').set('bad', [1, 2, 3, 4, 5])
  expect(() => validateCanvasUndoLineage(doc)).toThrow('invalid_canvas_undo_lineage')
  undo.destroy()
  doc.destroy()
})

it('rejects cyclic item pointers without recursing or partially installing them', () => {
  const doc = new Y.Doc({ gc: false })
  const text = doc.getText('text')
  text.insert(0, 'a')
  const first = text._start!
  text.delete(0, 1)
  text.insert(0, 'b')
  const second = text._start!.right!
  text.delete(0, 1)
  const lineage = doc.getMap('undoLineage')
  lineage.set(`${first.id.client}:${first.id.clock}`, [
    first.id.client,
    first.id.clock,
    1,
    second.id.client,
    second.id.clock,
  ])
  lineage.set(`${second.id.client}:${second.id.clock}`, [
    second.id.client,
    second.id.clock,
    1,
    first.id.client,
    first.id.clock,
  ])
  expect(() => restoreCanvasUndoLineage(doc)).toThrow('invalid_canvas_undo_lineage')
  expect(first.redone).toBeNull()
  expect(second.redone).toBeNull()
  doc.destroy()
})

it('restores every receiver segment of a sender-merged text range, including its terminal newline', () => {
  const doc = new Y.Doc({ gc: false })
  const text = doc.getText('text')
  text.insert(0, 'body\n')
  const source = text._start!.id
  text.delete(0, text.length)
  text.insert(0, 'body\n')
  const target = Y.createID(doc.clientID, 5)
  doc
    .getMap('undoLineage')
    .set(`${source.client}:${source.clock}`, [
      source.client,
      source.clock,
      5,
      target.client,
      target.clock,
    ])
  doc.transact((transaction) => {
    const newline = Y.getItemCleanStart(transaction, Y.createID(source.client, source.clock + 4))
    restoreCanvasUndoLineage(doc)
    expect(newline.redone).toEqual(Y.createID(target.client, target.clock + 4))
  })
  doc.destroy()
})

it('keeps a collected text neighbor traceable so redo retains its insertion position', () => {
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, '\n')
  const source = text._start!
  text.delete(0, 1)
  expect(source.content).toBeInstanceOf(Y.ContentDeleted)
  text.insert(0, '\n')
  const target = Y.createID(doc.clientID, 1)
  doc
    .getMap('undoLineage')
    .set(`${source.id.client}:${source.id.clock}`, [
      source.id.client,
      source.id.clock,
      1,
      target.client,
      target.clock,
    ])
  restoreCanvasUndoLineage(doc)
  expect(source.redone).toEqual(target)
  doc.destroy()
})

it('restores a source split later by another lineage range regardless of map insertion order', () => {
  const doc = new Y.Doc({ gc: false })
  const p = doc.getText('p'),
    a = doc.getText('a'),
    b = doc.getText('b')
  p.insert(0, '12345')
  a.insert(0, '12345')
  b.insert(0, '12345')
  const pId = p._start!.id,
    aId = a._start!.id,
    bId = b._start!.id
  p.delete(0, 5)
  a.delete(0, 5)
  const lineage = doc.getMap('undoLineage')
  lineage.set(`${aId.client}:${aId.clock}`, [aId.client, aId.clock, 5, bId.client, bId.clock])
  lineage.set(`${pId.client}:${pId.clock}`, [pId.client, pId.clock, 5, aId.client, aId.clock])
  doc.transact((transaction) => {
    Y.getItemCleanStart(transaction, Y.createID(pId.client, pId.clock + 1))
    restoreCanvasUndoLineage(doc)
    expect(Y.getItem(doc.store, Y.createID(aId.client, aId.clock + 1)).redone).toEqual(
      Y.createID(bId.client, bId.clock + 1),
    )
  })
  doc.destroy()
})
