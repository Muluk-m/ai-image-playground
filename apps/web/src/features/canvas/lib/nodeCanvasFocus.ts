import type { CanvasEditor } from './editor'

export type NodeCanvasFocus = (ids: readonly string[]) => boolean

type Registration = {
  focus: NodeCanvasFocus
  token: symbol
}

const registrations = new WeakMap<CanvasEditor, Registration>()

/** Register the mounted React Flow view for external selection and navigation requests. */
export function registerNodeCanvasFocus(editor: CanvasEditor, focus: NodeCanvasFocus): () => void {
  const token = Symbol('node-canvas-focus')
  registrations.set(editor, { focus, token })
  return () => {
    if (registrations.get(editor)?.token === token) registrations.delete(editor)
  }
}

/** Focus nodes in the mounted NodeCanvas belonging to this editor. */
export function focusNodeCanvas(editor: CanvasEditor, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  return registrations.get(editor)?.focus(ids) ?? false
}
