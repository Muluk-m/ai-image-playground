import {
  canvasOrigin,
  createCanvasUndoManager,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  type CanvasCommandSummary,
  CloudCanvasHistory,
} from '../../../../features/canvas/lib/nodeCanvasHistory'

const docs: Y.Doc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
  vi.useRealTimers()
})
function setup(reverse = vi.fn(async (_command: CanvasCommandSummary) => {})) {
  const doc = new Y.Doc()
  docs.push(doc)
  const origin = canvasOrigin('user', 'test')
  const failed = vi.fn()
  const history = new CloudCanvasHistory(createCanvasUndoManager(doc, origin), reverse, failed)
  const add = (id: string) => {
    history.stopCapturing()
    insertCanvasNode(
      doc,
      {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        data: { text: id, fontSize: 16, fill: '#fff' },
      },
      origin,
    )
  }
  return { doc, history, add, reverse, failed }
}
const command = {
  id: 'one',
  label: '创建节点',
  revision: 0,
  reversed: false,
  createdAt: 200,
  updatedAt: 200,
}
it('orders local edits and remote commands in the same undo/redo history', async () => {
  vi.useFakeTimers()
  const { doc, history, add, reverse } = setup()
  vi.setSystemTime(100)
  add('before')
  history.accept([command])
  vi.setSystemTime(300)
  add('after')
  expect(history.undoStack).toHaveLength(3)
  history.undo()
  expect(readCanvasDocument(doc).nodes.map((n) => n.id)).toEqual(['before'])
  expect(reverse).not.toHaveBeenCalled()
  history.undo()
  expect(reverse).toHaveBeenCalledWith(command)
  expect(history.undoStack).toHaveLength(0)
  history.accept([{ ...command, revision: 1, reversed: true, updatedAt: 400 }])
  await Promise.resolve()
  expect(history.undoStack).toHaveLength(1)
  expect(history.redoStack).toHaveLength(2)
  history.undo()
  expect(readCanvasDocument(doc).nodes).toEqual([])
  history.destroy()
})
it('keeps a failed server undo retryable and prevents duplicate in-flight requests', async () => {
  let reject!: (error: Error) => void
  const reverse = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  const { history, failed } = setup(reverse)
  history.accept([command])
  history.undo()
  history.undo()
  expect(reverse).toHaveBeenCalledTimes(1)
  reject(new Error('offline'))
  await Promise.resolve()
  await Promise.resolve()
  expect(failed).toHaveBeenCalledTimes(1)
  expect(history.undoStack).toHaveLength(1)
  history.destroy()
})
it('does not duplicate a command after repeated sync, and observes another browser reversing it', () => {
  const { history } = setup()
  history.accept([command])
  history.accept([command])
  expect(history.undoStack).toHaveLength(1)
  history.accept([{ ...command, revision: 1, reversed: true, updatedAt: 300 }])
  expect(history.undoStack).toHaveLength(0)
  expect(history.redoStack).toHaveLength(1)
  history.destroy()
})
it('does not skip a remote-invalidated local item across an Agent command', async () => {
  vi.useFakeTimers()
  const { doc, history, add, reverse } = setup()
  vi.setSystemTime(100)
  add('before')
  history.accept([command])
  vi.setSystemTime(300)
  const origin = canvasOrigin('user', 'test')
  history.stopCapturing()
  doc.transact(() => doc.getMap<Y.Map<unknown>>('nodes').get('before')!.set('x', 50), origin)
  // Another writer wins the same field. Yjs normally skips this now-invalid undo item.
  doc.transact(() => doc.getMap<Y.Map<unknown>>('nodes').get('before')!.set('x', 75), 'remote')
  history.undo()
  expect(readCanvasDocument(doc).nodes).toHaveLength(1)
  expect(readCanvasDocument(doc).nodes[0]?.x).toBe(75)
  expect(reverse).not.toHaveBeenCalled()
  history.undo()
  expect(reverse).toHaveBeenCalledWith(command)
  await Promise.resolve()
  history.destroy()
})
it('removes expired server history without blocking older local undo', () => {
  vi.useFakeTimers()
  const { doc, history, add } = setup()
  vi.setSystemTime(100)
  add('local')
  history.accept([command])
  history.accept([])
  expect(history.undoStack).toHaveLength(1)
  history.undo()
  expect(readCanvasDocument(doc).nodes).toEqual([])
  history.destroy()
})
it('redos local edits using the new inverse StackItem', () => {
  const { doc, history, add } = setup()
  add('first')
  add('second')
  history.undo()
  history.undo()
  expect(readCanvasDocument(doc).nodes).toHaveLength(0)
  history.redo()
  history.redo()
  expect(readCanvasDocument(doc).nodes).toHaveLength(2)
  history.undo()
  expect(readCanvasDocument(doc).nodes.map((n) => n.id)).toEqual(['first'])
  history.destroy()
})

it('tracks rich-text editor origins and clears only the requested history direction', () => {
  const { doc, history, add } = setup()
  add('text')
  history.clear()
  const richTextOrigin = {}
  history.addTrackedOrigin(richTextOrigin)
  doc.transact(() => doc.getMap<Y.Map<unknown>>('nodes').get('text')!.set('x', 50), richTextOrigin)
  expect(history.undoStack).toHaveLength(1)
  history.undo()
  expect(readCanvasDocument(doc).nodes[0]?.x).toBe(0)
  history.clear(true, false)
  expect(history.redoStack).toHaveLength(1)
  history.redo()
  history.removeTrackedOrigin(richTextOrigin)
  history.clear()
  doc.transact(() => doc.getMap<Y.Map<unknown>>('nodes').get('text')!.set('x', 75), richTextOrigin)
  expect(history.undoStack).toHaveLength(0)
  history.destroy()
})

it('keeps the document and redo entry intact when a redo would exceed the history budget', () => {
  const { doc, history, add, failed } = setup()
  add('one')
  history.undo()
  const lineage = doc.getMap('undoLineage')
  doc.transact(() => {
    for (let i = 0; i < 20_000; i++) lineage.set(`1:${i}`, [1, i, 1, 2, i])
  }, 'remote')
  const before = Y.encodeStateAsUpdate(doc)
  history.redo()
  expect(failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'canvas_undo_history_too_large' }),
  )
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  expect(history.redoStack).toHaveLength(1)
  expect(readCanvasDocument(doc).nodes).toEqual([])
  history.destroy()
})
