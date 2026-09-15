import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { useStore } from '../../../store'
import { setAgentCanvasSink } from '../../agent/lib/canvasSink'
import { createAgentCanvasSink } from './agentCanvasSink'
import { CanvasDoc } from './canvasDoc'
import { CanvasEditor } from './editor'
import { loadScene, PERSIST_DEBOUNCE_MS, saveScene } from './persistence'
import { recoverCanvasTasks } from './recoverCanvasTasks'

export function canvasSceneKey(conversationId: string | null): string {
  return `${scopedStorageName('canvas')}:${conversationId ? `conversation:${encodeURIComponent(conversationId)}` : 'draft'}`
}

/** 生命周期属于会话，切模式/切会话只换视图，异步任务仍写原文档并自动保存。 */
export class CanvasWorkspace {
  readonly id = crypto.randomUUID()
  readonly doc = new CanvasDoc()
  readonly editor = new CanvasEditor(this.doc)
  readonly sink = createAgentCanvasSink(this.editor, () => this.ready)
  ready: Promise<unknown>
  private state = { loading: true, loadFailed: false, saveFailed: false }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private revision = 0
  private savedRevision = 0

  constructor(
    private key: string,
    private migrateLegacy = false,
  ) {
    this.sink.background = true
    this.ready = this.load()
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<typeof this.state>) {
    if (patch.saveFailed && !this.state.saveFailed)
      useStore
        .getState()
        .showToast(
          '画布保存失败，内容仍在当前页面。请回到对应会话重试保存，成功前不要刷新或关闭。',
          'error',
        )
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async load() {
    this.update({ loading: true, loadFailed: false })
    try {
      await loadScene(this.editor, this.key, this.migrateLegacy)
      let { elements, files, camera } = this.doc
      this.editor.onChange(() => {
        if (
          elements === this.doc.elements &&
          files === this.doc.files &&
          camera === this.doc.camera
        )
          return
        ;({ elements, files, camera } = this.doc)
        this.revision += 1
        clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.flush(), PERSIST_DEBOUNCE_MS)
      })
      recoverCanvasTasks(this.editor)
      this.update({ loading: false })
    } catch (error) {
      this.update({ loading: false, loadFailed: true })
      throw error
    }
  }
  retryLoad = () => {
    this.ready = this.load()
    void this.ready.catch(() => {})
  }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer)
    const save = this.writes.then(async () => {
      if (this.state.loading || this.state.loadFailed) return false
      if (this.savedRevision === this.revision && !this.state.saveFailed) return true
      const revision = this.revision
      const saved = await saveScene(this.editor, this.key)
      if (saved) this.savedRevision = revision
      this.update({ saveFailed: !saved })
      return saved
    })
    this.writes = save
    return save
  }
  /** 先原子提交新会话存档并移走草稿，再改内存键；失败时继续保留原草稿。 */
  bind(key: string): Promise<boolean> {
    const bind = this.writes.then(async () => {
      try {
        await this.ready
      } catch {
        return false
      }
      const revision = this.revision
      const saved = await saveScene(this.editor, key, this.key)
      if (saved) {
        this.key = key
        this.savedRevision = revision
      }
      this.update({ saveFailed: !saved })
      return saved
    })
    this.writes = bind
    return bind
  }
}

const workspaces = new Map<string, CanvasWorkspace>()
const listeners = new Set<() => void>()
let current: CanvasWorkspace | undefined
let visible = false
let lifecycleInstalled = false

function workspace(key: string, migrateLegacy = false): CanvasWorkspace {
  let value = workspaces.get(key)
  if (!value) {
    value = new CanvasWorkspace(key, migrateLegacy)
    void value.ready.catch(() => {})
    workspaces.set(key, value)
  }
  return value
}

export function currentCanvasWorkspace(): CanvasWorkspace {
  if (!current) {
    const remembered = safeLocalStorage.getItem(scopedStorageName(AGENT_CONVERSATION_KEY))
    current = workspace(canvasSceneKey(remembered), true)
  }
  if (!lifecycleInstalled) {
    lifecycleInstalled = true
    const flush = () => {
      for (const item of workspaces.values()) void item.flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
  return current
}

export function subscribeCanvasWorkspace(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function showCanvasWorkspace(show: boolean): void {
  visible = show
  setAgentCanvasSink(show ? currentCanvasWorkspace().sink : null)
  if (!show) void current?.flush()
}

export function selectCanvasWorkspace(conversationId: string | null): void {
  // 不在画布里时无需加载图片；下次打开画布从记住的会话初始化。
  if (!current) return
  void current.flush()
  current = workspace(canvasSceneKey(conversationId))
  if (visible) setAgentCanvasSink(current.sink)
  for (const listener of listeners) listener()
}

export async function bindNewCanvasWorkspace(conversationId: string): Promise<boolean> {
  if (!current) return true
  const draftKey = canvasSceneKey(null)
  const draft = workspaces.get(draftKey)
  if (draft !== current) return false
  const key = canvasSceneKey(conversationId)
  if (!(await draft.bind(key))) return false
  workspaces.delete(draftKey)
  workspaces.set(key, draft)
  return true
}
