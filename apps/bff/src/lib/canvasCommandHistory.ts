import {
  type CanvasOrigin,
  canvasOrigin,
  createCanvasUndoManager,
  publishCanvasUndoLineage,
  restoreCanvasUndoLineage,
} from '@image-playground/shared'
import * as Y from 'yjs'

export interface CanvasCommandRecord {
  before: Uint8Array
  update: Uint8Array
}

const commandOrigin = canvasOrigin('agent', 'command')

/** A failed batch must never publish a partial write. */
export function prepareCanvasCommand(
  state: Uint8Array,
  mutate: (doc: Y.Doc, origin: CanvasOrigin) => void,
): CanvasCommandRecord {
  const doc = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(doc, state)
    const vector = Y.encodeStateVector(doc)
    doc.transact(() => mutate(doc, commandOrigin), commandOrigin)
    return { before: state, update: Y.encodeStateAsUpdate(doc, vector) }
  } finally {
    doc.destroy()
  }
}

/**
 * Rebuild this command's undo stack, then merge today's document before undoing it.
 * Yjs keeps later user changes; restoring a JSON snapshot would discard them.
 * The resulting record is itself reversible: redo uses the same operation.
 */
export function reverseCanvasCommand(
  state: Uint8Array,
  command: CanvasCommandRecord,
): CanvasCommandRecord {
  const doc = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(doc, command.before)
    const undo = createCanvasUndoManager(doc, commandOrigin)
    try {
      Y.applyUpdate(doc, command.update, commandOrigin)
      undo.stopCapturing()
      Y.applyUpdate(doc, state)
      restoreCanvasUndoLineage(doc)
      const vector = Y.encodeStateVector(doc)
      undo.undo()
      publishCanvasUndoLineage(doc)
      return { before: state, update: Y.encodeStateAsUpdate(doc, vector) }
    } finally {
      undo.destroy()
    }
  } finally {
    doc.destroy()
  }
}
