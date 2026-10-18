import type { CanvasEditor } from './editor'

export type NodeCanvasFocus = (ids: readonly string[]) => boolean

type Registration = {
  focus: NodeCanvasFocus
  reveal: NodeCanvasFocus
  token: symbol
}

const registrations = new WeakMap<CanvasEditor, Registration>()

/** Register the mounted React Flow view for external selection and navigation requests. */
export function registerNodeCanvasFocus(
  editor: CanvasEditor,
  focus: NodeCanvasFocus,
  reveal: NodeCanvasFocus,
): () => void {
  const token = Symbol('node-canvas-focus')
  registrations.set(editor, { focus, reveal, token })
  return () => {
    if (registrations.get(editor)?.token === token) registrations.delete(editor)
  }
}

/** Focus nodes in the mounted NodeCanvas belonging to this editor. */
export function focusNodeCanvas(editor: CanvasEditor, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  return registrations.get(editor)?.focus(ids) ?? false
}

/** Reveal nodes without changing the current reference selection or zoom. */
export function revealNodeCanvas(editor: CanvasEditor, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  return registrations.get(editor)?.reveal(ids) ?? false
}
