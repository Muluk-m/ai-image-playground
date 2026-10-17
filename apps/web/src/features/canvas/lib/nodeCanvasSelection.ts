import { canvasText } from '@image-playground/shared'
import type * as Y from 'yjs'
import type { CanvasEditor } from './editor'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

// Local interaction state belongs to the open editor, never the shared Y.Doc.
const selections = new WeakMap<
  CanvasEditor,
  { canvas: NodeCanvasDocument; ids: readonly string[]; changed: (tx: Y.Transaction) => void }
>()
const listeners = new Set<() => void>()
let revision = 0
function changed() {
  revision += 1
  for (const listener of listeners) listener()
}
export function subscribeNodeCanvasSelection(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function nodeCanvasSelectionRevision() {
  return revision
}
export function setNodeCanvasSelection(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  ids: readonly string[],
) {
  const previous = selections.get(editor)
  if (
    previous?.canvas === canvas &&
    previous.ids.length === ids.length &&
    previous.ids.every((id, index) => id === ids[index])
  )
    return
  const notify =
    previous?.canvas === canvas
      ? previous.changed
      : (tx: Y.Transaction) => {
          const nodes = canvas.doc.getMap<Y.Map<unknown>>('nodes')
          const groups = canvas.doc.getMap<Y.Map<unknown>>('groups')
          const ids = selections.get(editor)?.ids ?? []
          for (const id of ids) {
            const node = nodes.get(id)
            const group = groups.get(id)
            const text = canvasText(canvas.doc, id)
            const fields = node && tx.changed.get(node)
            if (
              tx.changed.get(nodes)?.has(id) ||
              tx.changed.get(groups)?.has(id) ||
              (group && tx.changed.get(group)?.has('name')) ||
              fields?.has('data') ||
              fields?.has('type') ||
              fields?.has('richText') ||
              (text && tx.changed.has(text))
            ) {
              changed()
              return
            }
          }
        }
  if (previous?.canvas !== canvas) {
    previous?.canvas.doc.off('afterTransaction', previous.changed)
    canvas.doc.on('afterTransaction', notify)
  }
  selections.set(editor, { canvas, ids: [...ids], changed: notify })
  changed()
}
export function clearNodeCanvasSelection(editor: CanvasEditor, canvas: NodeCanvasDocument) {
  const previous = selections.get(editor)
  if (previous?.canvas !== canvas) return
  canvas.doc.off('afterTransaction', previous.changed)
  selections.delete(editor)
  changed()
}
export function nodeCanvasSelection(editor: CanvasEditor): readonly string[] | undefined {
  const selection = selections.get(editor)
  if (!selection) return undefined
  const nodes = selection.canvas.doc.getMap('nodes')
  const groups = selection.canvas.doc.getMap('groups')
  return selection.ids.filter((id) => nodes.has(id) || groups.has(id))
}

export function activeNodeCanvas(editor: CanvasEditor): NodeCanvasDocument | undefined {
  return selections.get(editor)?.canvas
}
