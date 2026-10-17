import { readCanvasDocument } from '@image-playground/shared'
import type { CanvasEditor } from './editor'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

// Local interaction state belongs to the open editor, never the shared Y.Doc.
const selections = new WeakMap<
  CanvasEditor,
  { canvas: NodeCanvasDocument; ids: readonly string[]; changed: () => void }
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
  const notify = previous?.canvas === canvas ? previous.changed : () => changed()
  if (previous?.canvas !== canvas) {
    previous?.canvas.doc.off('update', previous.changed)
    canvas.doc.on('update', notify)
  }
  selections.set(editor, { canvas, ids: [...ids], changed: notify })
  changed()
}
export function clearNodeCanvasSelection(editor: CanvasEditor, canvas: NodeCanvasDocument) {
  const previous = selections.get(editor)
  if (previous?.canvas !== canvas) return
  canvas.doc.off('update', previous.changed)
  selections.delete(editor)
  changed()
}
export function nodeCanvasSelection(editor: CanvasEditor): readonly string[] | undefined {
  const selection = selections.get(editor)
  if (!selection) return undefined
  const graph = readCanvasDocument(selection.canvas.doc)
  const existing = new Set([
    ...graph.nodes.map((node) => node.id),
    ...(graph.groups ?? []).map((group) => group.id),
  ])
  return selection.ids.filter((id) => existing.has(id))
}

export function activeNodeCanvas(editor: CanvasEditor): NodeCanvasDocument | undefined {
  return selections.get(editor)?.canvas
}
