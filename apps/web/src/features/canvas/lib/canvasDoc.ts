import type { CanvasTaskMeta, CanvasTaskStatus } from './editor'

/**
 * 自建画布的文档模型 + 状态容器（替代第三方画布库的 store）。
 * 设计原则：
 * - 元素数组 / 元素对象 copy-on-write，快照即引用，undo/redo 零拷贝
 * - camera / 选区 / 工具是瞬态（不入历史、不持久化选区与工具）
 * - 所有变更走本类方法并 emit，React 侧 useSyncExternalStore 订阅 version
 */

export type Tool = 'select' | 'hand' | 'pen' | 'eraser' | 'arrow' | 'text'

export interface ImageEl {
  id: string
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  /** 旋转角度（度），绕左上角。 */
  rotation: number
  fileId: string
  /** 生成溯源（prompt 等）。 */
  meta?: Record<string, string>
}

export interface FreedrawEl {
  id: string
  type: 'freedraw'
  /** 页面坐标扁平点列 [x0,y0,x1,y1,...]。 */
  points: number[]
  stroke: string
  strokeWidth: number
}

export interface ArrowEl {
  id: string
  type: 'arrow'
  /** [x1,y1,x2,y2] 页面坐标。 */
  points: [number, number, number, number]
  stroke: string
  strokeWidth: number
}

export interface TextEl {
  id: string
  type: 'text'
  x: number
  y: number
  text: string
  fontSize: number
  fill: string
  /** 提交时用 Konva.Text 量出的包围盒，选区/导出复用。 */
  width: number
  height: number
}

export interface PlaceholderEl {
  id: string
  type: 'placeholder'
  x: number
  y: number
  width: number
  height: number
  status: CanvasTaskStatus
  message: string
  meta: CanvasTaskMeta
}

export type CanvasEl = ImageEl | FreedrawEl | ArrowEl | TextEl | PlaceholderEl

export interface Camera {
  /** 视口左上角的页面坐标。 */
  x: number
  y: number
  zoom: number
}

interface HistorySnapshot {
  elements: readonly CanvasEl[]
  files: Readonly<Record<string, string>>
}

const HISTORY_LIMIT = 100
export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 8

let idCounter = 0
export function newElementId(): string {
  // 时间戳 + 计数器：跨会话不撞、同帧多元素不撞（uuid 没必要）。
  idCounter += 1
  return `el_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

export class CanvasDoc {
  elements: readonly CanvasEl[] = []
  /** fileId → dataUrl（图片位图单源，随场景持久化）。 */
  files: Readonly<Record<string, string>> = {}
  selection: ReadonlySet<string> = new Set()
  camera: Camera = { x: 0, y: 0, zoom: 1 }
  viewport = { width: 1, height: 1 }
  tool: Tool = 'select'
  penColor = '#ef4444'
  /** 画笔 / 箭头线宽（页面单位）。 */
  penWidth = 4
  /** 新建文字的字号（页面单位）。 */
  textFontSize = 28
  /** 正在内联编辑的 text 元素 id（编辑期间画布快捷键让位）。 */
  editingTextId: string | null = null
  /** 单调递增版本号，驱动 useSyncExternalStore。 */
  version = 0

  private listeners = new Set<() => void>()
  private undoStack: HistorySnapshot[] = []
  private redoStack: HistorySnapshot[] = []

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    this.version += 1
    for (const cb of this.listeners) cb()
  }

  // ===== 历史 =====

  /**
   * 在一次「不可分割的用户操作」开始前调用：快照当前状态入 undo 栈。
   * 拖拽 / 画笔这类连续手势只在手势开始 capture 一次，过程中的高频更新不入栈。
   */
  captureHistory(): void {
    this.undoStack.push({ elements: this.elements, files: this.files })
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    this.redoStack = []
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): void {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.redoStack.push({ elements: this.elements, files: this.files })
    this.elements = snap.elements
    this.files = snap.files
    this.pruneSelection()
    this.emit()
  }

  redo(): void {
    const snap = this.redoStack.pop()
    if (!snap) return
    this.undoStack.push({ elements: this.elements, files: this.files })
    this.elements = snap.elements
    this.files = snap.files
    this.pruneSelection()
    this.emit()
  }

  private pruneSelection(): void {
    const ids = new Set(this.elements.map((el) => el.id))
    this.selection = new Set([...this.selection].filter((id) => ids.has(id)))
    if (this.editingTextId && !ids.has(this.editingTextId)) this.editingTextId = null
  }

  // ===== 元素变更 =====

  getElement(id: string): CanvasEl | undefined {
    return this.elements.find((el) => el.id === id)
  }

  /** 追加元素（可携带新图片文件）。history=false 用于手势过程中的首帧（调用方已 capture）。 */
  addElements(
    els: CanvasEl[],
    opts: { files?: Record<string, string>; history?: boolean } = {},
  ): void {
    if (els.length === 0) return
    if (opts.history !== false) this.captureHistory()
    this.elements = [...this.elements, ...els]
    if (opts.files) this.files = { ...this.files, ...opts.files }
    this.emit()
  }

  /**
   * 按 id 打补丁（copy-on-write）。history 默认 false——连续手势的高频路径；
   * 离散操作（状态切换等）调用方传 history: true。
   */
  updateElements(
    patches: Array<{ id: string; patch: Partial<CanvasEl> }>,
    opts: { history?: boolean } = {},
  ): void {
    if (patches.length === 0) return
    const byId = new Map(patches.map((p) => [p.id, p.patch]))
    let changed = false
    const next = this.elements.map((el) => {
      const patch = byId.get(el.id)
      if (!patch) return el
      changed = true
      return { ...el, ...patch } as CanvasEl
    })
    if (!changed) return
    if (opts.history) this.captureHistory()
    this.elements = next
    this.emit()
  }

  /** history=false 用于手势内的回滚清理（过短的箭头 / 空文字），调用方已 capture。 */
  deleteElements(ids: string[], opts: { history?: boolean } = {}): void {
    const idSet = new Set(ids)
    const next = this.elements.filter((el) => !idSet.has(el.id))
    if (next.length === this.elements.length) return
    if (opts.history !== false) this.captureHistory()
    this.elements = next
    this.pruneSelection()
    this.emit()
  }

  // ===== 瞬态状态 =====

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set(ids)
    this.emit()
  }

  setCamera(patch: Partial<Camera>): void {
    this.camera = { ...this.camera, ...patch }
    this.emit()
  }

  /** 以视口内某个屏幕点为锚缩放（滚轮 / 捏合 / 缩放控件共用）。 */
  zoomAt(screenX: number, screenY: number, nextZoom: number): void {
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom))
    const { camera } = this
    const pageX = camera.x + screenX / camera.zoom
    const pageY = camera.y + screenY / camera.zoom
    this.setCamera({ x: pageX - screenX / zoom, y: pageY - screenY / zoom, zoom })
  }

  setViewport(width: number, height: number): void {
    if (this.viewport.width === width && this.viewport.height === height) return
    this.viewport = { width, height }
    this.emit()
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return
    this.tool = tool
    this.emit()
  }

  setPenColor(color: string): void {
    this.penColor = color
    this.emit()
  }

  setPenWidth(width: number): void {
    this.penWidth = width
    this.emit()
  }

  setTextFontSize(size: number): void {
    this.textFontSize = size
    this.emit()
  }

  setEditingText(id: string | null): void {
    this.editingTextId = id
    this.emit()
  }

  /** 持久化恢复：整体替换（不入历史，清空历史栈）。 */
  restore(elements: CanvasEl[], files: Record<string, string>, camera?: Camera): void {
    this.elements = elements
    this.files = files
    if (camera) this.camera = camera
    this.selection = new Set()
    this.undoStack = []
    this.redoStack = []
    this.emit()
  }

  /** 图片位图异步加载完成后的重绘通知（不改文档，只推版本）。 */
  notifyAssetLoaded(): void {
    this.emit()
  }
}
