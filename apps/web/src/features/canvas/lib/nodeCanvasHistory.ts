import {
  CANVAS_STATE_MAX_BYTES,
  canvasOrigin,
  createCanvasUndoManager,
  publishCanvasUndoLineage,
  restoreCanvasUndoLineage,
  validateCanvasUndoLineage,
} from '@image-playground/shared'
import * as Y from 'yjs'

export type CanvasHistoryEvent = 'stack-item-added' | 'stack-item-popped' | 'stack-cleared'
export interface CanvasHistory {
  readonly undoStack: readonly unknown[]
  readonly redoStack: readonly unknown[]
  undo(): void
  redo(): void
  stopCapturing(): void
  clear(clearUndoStack?: boolean, clearRedoStack?: boolean): void
  addTrackedOrigin(origin: unknown): void
  removeTrackedOrigin(origin: unknown): void
  on(event: CanvasHistoryEvent, listener: () => void): void
  off(event: CanvasHistoryEvent, listener: () => void): void
  destroy(): void
}
export interface CanvasCommandSummary {
  id: string
  label: string
  revision: number
  reversed: boolean
  createdAt: number
  updatedAt: number
}
type LocalEntry = { kind: 'local'; item: Y.UndoManager['undoStack'][number]; at: number }
type CommandEntry = { kind: 'command'; command: CanvasCommandSummary; at: number }
type Entry = LocalEntry | CommandEntry

/** One toolbar/shortcut history for local Yjs edits and durable server commands. */
export class CloudCanvasHistory implements CanvasHistory {
  private past: Entry[] = []
  private future: Entry[] = []
  private commands = new Map<string, number>()
  private listeners = new Map<CanvasHistoryEvent, Set<() => void>>()
  private changing = false
  private busy = false
  private destroyed = false
  constructor(
    private local: Y.UndoManager,
    private reverse: (command: CanvasCommandSummary) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {
    local.on('stack-item-added', this.added)
  }
  private added = ({
    stackItem,
    type,
  }: {
    stackItem: Y.UndoManager['undoStack'][number]
    type: 'undo' | 'redo'
  }) => {
    if (this.changing || type !== 'undo') return
    this.past.push({ kind: 'local', item: stackItem, at: Date.now() })
    this.future = []
    this.emit('stack-item-added')
  }
  get undoStack() {
    return this.busy ? [] : this.past
  }
  get redoStack() {
    return this.busy ? [] : this.future
  }
  accept(commands: readonly CanvasCommandSummary[]) {
    if (this.destroyed) return
    const currentIds = new Set(commands.map((command) => command.id))
    for (const id of this.commands.keys()) if (!currentIds.has(id)) this.commands.delete(id)
    const retain = (entry: Entry) => entry.kind === 'local' || currentIds.has(entry.command.id)
    const priorSize = this.past.length + this.future.length
    this.past = this.past.filter(retain)
    this.future = this.future.filter(retain)
    let changed = priorSize !== this.past.length + this.future.length
    for (const command of commands) {
      if (this.commands.get(command.id) === command.revision) continue
      changed = true
      this.commands.set(command.id, command.revision)
      const keep = (entry: Entry) => entry.kind !== 'command' || entry.command.id !== command.id
      this.past = this.past.filter(keep)
      this.future = this.future.filter(keep)
      const entry: CommandEntry = { kind: 'command', command, at: command.updatedAt }
      ;(command.reversed ? this.future : this.past).push(entry)
    }
    if (!changed) return
    this.stopCapturing()
    this.past.sort((a, b) => a.at - b.at)
    this.future.sort((a, b) => a.at - b.at)
    this.emit('stack-item-added')
  }
  undo() {
    void this.move(false)
  }
  redo() {
    void this.move(true)
  }
  private async move(redo: boolean) {
    if (this.busy || this.destroyed) return
    const source = redo ? this.future : this.past
    const entry = source[source.length - 1]
    if (!entry) return
    this.stopCapturing()
    if (entry.kind === 'local') {
      try {
        this.checkBudget(entry, redo)
      } catch (error) {
        this.failed(error)
        return
      }
      this.changing = true
      try {
        source.pop()
        // Yjs otherwise skips invalidated items and may cross an intervening Agent command.
        const key = redo ? 'redoStack' : 'undoStack'
        const earlier = this.local[key].filter((item) => item !== entry.item)
        const inverse = redo ? this.local.undoStack : this.local.redoStack
        const count = inverse.length
        this.local[key] = [entry.item]
        try {
          restoreCanvasUndoLineage(this.local.doc)
          if (redo) this.local.redo()
          else this.local.undo()
          publishCanvasUndoLineage(this.local.doc)
        } finally {
          this.local[key] = earlier
        }
        if (inverse.length > count)
          (redo ? this.past : this.future).push({
            kind: 'local',
            item: inverse[inverse.length - 1]!,
            at: Date.now(),
          })
      } finally {
        this.changing = false
      }
      this.emit('stack-item-popped')
      return
    }
    this.busy = true
    this.emit('stack-item-popped')
    try {
      await this.reverse(entry.command)
    } catch (error) {
      if (!this.destroyed) this.failed(error)
    } finally {
      this.busy = false
      this.emit('stack-item-popped')
    }
  }
  private checkBudget(entry: LocalEntry, redo: boolean) {
    // Dry-run on a disposable document: a full history must never strand an already
    // mutated IndexedDB document that the server can no longer accept.
    const preview = new Y.Doc({ gc: false })
    let undo: Y.UndoManager | undefined
    try {
      Y.applyUpdate(preview, Y.encodeStateAsUpdate(this.local.doc))
      restoreCanvasUndoLineage(preview)
      undo = createCanvasUndoManager(preview, canvasOrigin('user', 'history-budget'))
      undo[redo ? 'redoStack' : 'undoStack'] = [entry.item]
      if (redo) undo.redo()
      else undo.undo()
      publishCanvasUndoLineage(preview)
      validateCanvasUndoLineage(preview)
      if (Y.encodeStateAsUpdate(preview).length > CANVAS_STATE_MAX_BYTES - 1024)
        throw new Error('canvas_undo_history_too_large')
    } finally {
      undo?.destroy()
      preview.destroy()
    }
  }
  clear(clearUndoStack = true, clearRedoStack = true) {
    this.local.clear(clearUndoStack, clearRedoStack)
    if (clearUndoStack) this.past = []
    if (clearRedoStack) this.future = []
    this.emit('stack-cleared')
  }
  addTrackedOrigin(origin: unknown) {
    this.local.addTrackedOrigin(origin)
  }
  removeTrackedOrigin(origin: unknown) {
    this.local.removeTrackedOrigin(origin)
  }
  stopCapturing() {
    this.local.stopCapturing()
  }
  on(event: CanvasHistoryEvent, listener: () => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }
  off(event: CanvasHistoryEvent, listener: () => void) {
    this.listeners.get(event)?.delete(listener)
  }
  private emit(event: CanvasHistoryEvent) {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
  destroy() {
    this.destroyed = true
    this.local.off('stack-item-added', this.added)
    this.local.destroy()
    this.listeners.clear()
  }
}
