import type * as Y from 'yjs'
import { accountScope } from '../../../lib/authScope'
import { addCompletedCanvasTask } from '../../../store'

type History = Parameters<typeof addCompletedCanvasTask>[0]
interface PendingOutput {
  nodeId: string
  history: History
  writing?: Promise<void>
}
interface State {
  current: () => boolean
  outputs: Map<string, PendingOutput>
  listeners: Set<() => void>
}
const pending = new Map<string, State>()
function state(doc: Y.Doc): State {
  let value = pending.get(doc.guid)
  if (!value) {
    value = { current: accountScope(), outputs: new Map(), listeners: new Set() }
    pending.set(doc.guid, value)
  }
  return value
}
function changed(value: State) {
  for (const listener of value.listeners) listener()
}
async function write(doc: Y.Doc, id: string, output: PendingOutput): Promise<void> {
  if (output.writing) return output.writing
  const value = state(doc)
  output.writing = (async () => {
    if (!value.current()) return
    const saved = await addCompletedCanvasTask(output.history)
    if (saved && value.outputs.get(id) === output) value.outputs.delete(id)
  })().finally(() => {
    output.writing = undefined
    changed(value)
    if (!value.outputs.size && !value.listeners.size) pending.delete(doc.guid)
  })
  return output.writing
}
/** BYOK outputs have no server recovery source: keep their bytes until local persistence succeeds. */
export async function persistLocalNodeResults(
  doc: Y.Doc,
  nodeId: string,
  history: History & { id: string },
): Promise<void> {
  const value = state(doc)
  let output = value.outputs.get(history.id)
  if (!output) {
    output = { nodeId, history }
    value.outputs.set(history.id, output)
  }
  await write(doc, history.id, output)
}
export function subscribePendingNodeResults(doc: Y.Doc, listener: () => void): () => void {
  const value = state(doc)
  value.listeners.add(listener)
  return () => {
    value.listeners.delete(listener)
    if (!value.outputs.size && !value.listeners.size) pending.delete(doc.guid)
  }
}
export function pendingNodeResults(doc: Y.Doc, nodeId: string): number {
  return [...state(doc).outputs.values()].filter((output) => output.nodeId === nodeId).length
}
export async function retryNodeResultStorage(doc: Y.Doc, nodeId: string): Promise<void> {
  for (const [id, output] of state(doc).outputs)
    if (output.nodeId === nodeId) await write(doc, id, output)
}

/** Same-tab project navigation may replace the Y.Doc while its output is still awaiting disk. */
export function pendingNodeResultImage(
  doc: Y.Doc,
  taskId: string,
  outputIndex: number,
): string | undefined {
  const value = pending.get(doc.guid)
  return value?.current() ? value.outputs.get(taskId)?.history.images[outputIndex] : undefined
}
