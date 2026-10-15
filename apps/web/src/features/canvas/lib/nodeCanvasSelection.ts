import type { CanvasEditor } from './editor'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

// Local interaction state belongs to the open editor, never the shared Y.Doc.
const selections = new WeakMap<
  CanvasEditor,
  { canvas: NodeCanvasDocument; ids: readonly string[] }
>()
export function setNodeCanvasSelection(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  ids: readonly string[],
) {
  selections.set(editor, { canvas, ids: [...ids] })
}
export function clearNodeCanvasSelection(editor: CanvasEditor, canvas: NodeCanvasDocument) {
  if (selections.get(editor)?.canvas === canvas) selections.delete(editor)
}
export function nodeCanvasSelection(editor: CanvasEditor): readonly string[] | undefined {
  return selections.get(editor)?.ids
}
