import { describe, expect, it } from 'bun:test'
import {
  canvasOrigin,
  canvasText,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  insertCanvasNode,
  moveCanvasNodes,
  publishCanvasUndoLineage,
  readCanvasDocument,
  restoreCanvasUndoLineage,
  updateCanvasNode,
} from '@image-playground/shared'
import * as Y from 'yjs'
import { prepareCanvasCommand, reverseCanvasCommand } from '../../lib/canvasCommandHistory'

const user = canvasOrigin('user', 'test')
function add(doc: Y.Doc, id: string, origin = user) {
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
function state(doc: Y.Doc) {
  return Y.encodeStateAsUpdate(doc)
}
function node(doc: Y.Doc, id: string) {
  return readCanvasDocument(doc).nodes.find((n) => n.id === id)
}

describe('durable canvas command undo', () => {
  it('undoes a whole agent batch while preserving concurrent user drags and additions', () => {
    const doc = new Y.Doc()
    add(doc, 'existing')
    const command = prepareCanvasCommand(state(doc), (candidate, origin) => {
      add(candidate, 'one', origin)
      add(candidate, 'two', origin)
      connectCanvasNodes(candidate, { source: 'one', target: 'two' }, origin)
    })
    // These edits were made before the agent update reached the user's browser.
    moveCanvasNodes(doc, [{ id: 'existing', x: 500, y: 600 }], user)
    add(doc, 'user-created')
    Y.applyUpdate(doc, command.update)
    const reversal = reverseCanvasCommand(state(doc), command)
    Y.applyUpdate(doc, reversal.update)
    expect(
      readCanvasDocument(doc)
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['existing', 'user-created'])
    expect(node(doc, 'existing')).toMatchObject({ x: 500, y: 600 })
    expect(readCanvasDocument(doc).edges).toEqual([])
    const redo = reverseCanvasCommand(state(doc), reversal)
    Y.applyUpdate(doc, redo.update)
    expect(readCanvasDocument(doc).nodes).toHaveLength(4)
    expect(readCanvasDocument(doc).edges).toHaveLength(1)
    expect(node(doc, 'existing')).toMatchObject({ x: 500, y: 600 })
    doc.destroy()
  })

  it('does not restore stale geometry over a later user edit of the same field', () => {
    const doc = new Y.Doc()
    add(doc, 'existing')
    const command = prepareCanvasCommand(state(doc), (candidate, origin) => {
      moveCanvasNodes(candidate, [{ id: 'existing', x: 100, y: 100 }], origin)
    })
    Y.applyUpdate(doc, command.update)
    moveCanvasNodes(doc, [{ id: 'existing', x: 500, y: 600 }], user)
    Y.applyUpdate(doc, reverseCanvasCommand(state(doc), command).update)
    expect(node(doc, 'existing')).toMatchObject({ x: 500, y: 600 })
    doc.destroy()
  })

  it('restores deleted nodes and edges after the server document has been compacted', () => {
    const doc = new Y.Doc()
    add(doc, 'one')
    add(doc, 'two')
    connectCanvasNodes(doc, { source: 'one', target: 'two' }, user)
    const command = prepareCanvasCommand(state(doc), (candidate, origin) => {
      deleteCanvasNode(candidate, 'one', origin)
    })
    Y.applyUpdate(doc, command.update)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, state(doc))
    doc.destroy()
    Y.applyUpdate(restored, reverseCanvasCommand(state(restored), command).update)
    expect(node(restored, 'one')?.data).toMatchObject({ text: 'one' })
    expect(readCanvasDocument(restored).edges).toHaveLength(1)
    restored.destroy()
  })

  it('undoes text changes without reverting a later independent node movement', () => {
    const doc = new Y.Doc()
    add(doc, 'one')
    const command = prepareCanvasCommand(state(doc), (candidate, origin) => {
      updateCanvasNode(
        candidate,
        'one',
        { data: { text: 'agent rewrite', fontSize: 16, fill: '#fff' } },
        origin,
      )
    })
    Y.applyUpdate(doc, command.update)
    moveCanvasNodes(doc, [{ id: 'one', x: 30, y: 40 }], user)
    Y.applyUpdate(doc, reverseCanvasCommand(state(doc), command).update)
    expect(node(doc, 'one')).toMatchObject({ x: 30, y: 40, data: { text: 'one' } })
    doc.destroy()
  })

  it('preserves text typed after the Agent rewrite when undoing that rewrite', () => {
    const doc = new Y.Doc()
    add(doc, 'one')
    const command = prepareCanvasCommand(state(doc), (candidate, origin) => {
      updateCanvasNode(
        candidate,
        'one',
        { data: { text: 'agent rewrite', fontSize: 16, fill: '#fff' } },
        origin,
      )
    })
    Y.applyUpdate(doc, command.update)
    const text = canvasText(doc, 'one')!
    doc.transact(() => text.insert(text.length - 1, ' + user'), user)
    Y.applyUpdate(doc, reverseCanvasCommand(state(doc), command).update)
    expect(node(doc, 'one')?.data).toMatchObject({ text: 'one + user' })
    doc.destroy()
  })

  it('keeps the source unchanged when a later operation in a batch throws', () => {
    const doc = new Y.Doc()
    expect(() =>
      prepareCanvasCommand(state(doc), (candidate, origin) => {
        add(candidate, 'one', origin)
        throw new Error('invalid connection')
      }),
    ).toThrow('invalid connection')
    expect(readCanvasDocument(doc).nodes).toEqual([])
    doc.destroy()
  })
})

it('redos dependent text edits after undoing and restoring the node creation', () => {
  const doc = new Y.Doc()
  const created = prepareCanvasCommand(state(doc), (candidate, origin) =>
    add(candidate, 'one', origin),
  )
  Y.applyUpdate(doc, created.update)
  const edited = prepareCanvasCommand(state(doc), (candidate, origin) =>
    updateCanvasNode(
      candidate,
      'one',
      { data: { text: 'edited', fontSize: 16, fill: '#fff' } },
      origin,
    ),
  )
  Y.applyUpdate(doc, edited.update)
  const undoEdit = reverseCanvasCommand(state(doc), edited)
  Y.applyUpdate(doc, undoEdit.update)
  const undoCreate = reverseCanvasCommand(state(doc), created)
  Y.applyUpdate(doc, undoCreate.update)
  const redoCreate = reverseCanvasCommand(state(doc), undoCreate)
  Y.applyUpdate(doc, redoCreate.update)
  Y.applyUpdate(doc, reverseCanvasCommand(state(doc), undoEdit).update)
  expect(node(doc, 'one')?.data).toMatchObject({ text: 'edited' })
  doc.destroy()
})

for (const localCreates of [true, false])
  it(`restores mixed browser/server history when ${localCreates ? 'the browser' : 'the Agent'} created the node`, () => {
    for (let sample = 0; sample < 20; sample++) {
      const browser = new Y.Doc()
      const server = new Y.Doc()
      const undo = createCanvasUndoManager(browser, user)
      const sync = () => {
        Y.applyUpdate(server, state(browser))
        Y.applyUpdate(browser, state(server))
      }
      const localStep = (redo: boolean) => {
        restoreCanvasUndoLineage(browser)
        if (redo) undo.redo()
        else undo.undo()
        publishCanvasUndoLineage(browser)
        sync()
      }
      let command: ReturnType<typeof prepareCanvasCommand>
      if (localCreates) {
        add(browser, 'one')
        undo.stopCapturing()
        sync()
        command = prepareCanvasCommand(state(server), (doc, origin) =>
          updateCanvasNode(
            doc,
            'one',
            { data: { text: 'edited', fontSize: 16, fill: '#fff' } },
            origin,
          ),
        )
        Y.applyUpdate(server, command.update)
        sync()
      } else {
        command = prepareCanvasCommand(state(server), (doc, origin) => add(doc, 'one', origin))
        Y.applyUpdate(server, command.update)
        sync()
        updateCanvasNode(
          browser,
          'one',
          { data: { text: 'edited', fontSize: 16, fill: '#fff' } },
          user,
        )
        undo.stopCapturing()
        sync()
      }
      const agentStep = () => {
        command = reverseCanvasCommand(state(server), command)
        Y.applyUpdate(server, command.update)
        sync()
      }
      for (let i = 0; i < 3; i++) {
        if (localCreates) {
          agentStep()
          localStep(false)
        } else {
          localStep(false)
          agentStep()
        }
        expect(node(browser, 'one')).toBeUndefined()
        if (localCreates) {
          localStep(true)
          agentStep()
        } else {
          agentStep()
          localStep(true)
        }
        expect(node(browser, 'one')?.data).toMatchObject({ text: 'edited' })
        expect(node(server, 'one')?.data).toMatchObject({ text: 'edited' })
      }
      undo.destroy()
      browser.destroy()
      server.destroy()
    }
  })
