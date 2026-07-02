import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToCanvas,
  getCommonBounds,
  newElementWith,
} from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasProfileSnapshot } from '../../../store'
import type { TaskParams } from '../../../types'
import { Box } from './geometry'

/** 占位框的可视状态：运行中 / 失败 / 失效（不可恢复）。 */
export type CanvasTaskStatus = 'loading' | 'error' | 'stale'

/** 占位框各状态的主题色（画布元素描边 + overlay 内容共用同一单源）。 */
export const STATUS_ACCENT: Record<CanvasTaskStatus, string> = {
  loading: '#3b82f6',
  error: '#ef4444',
  stale: '#f59e0b',
}

/**
 * 占位框的任务恢复元数据（决策 2）。存在元素 `customData` 上、随画布持久化，
 * 是任务状态的**单一持久真相源**——恢复时扫描运行态占位框的 meta 即可，
 * 不另设独立任务表。只存轻量 id / 标识，**绝不**把输入图塞进来（决策 2 / 决策 6）。
 */
export interface CanvasTaskMeta {
  taskId: string
  clientRequestId: string
  /** BFF submit 成功后经 onQueueSubmitted 回填；有它才能 resume 续 poll。 */
  bffRequestId?: string
  /** 发起时的 profile 来源，决定重开后能否恢复（仅 builtin-edge 可恢复）。 */
  source: 'builtin-edge' | 'user-byok'
  /** 人话需求（不含指令样板），供失效 / 错误态「重试」与落历史复用。 */
  prompt: string
  /** 是否标注模式：重试时据此重新注入指令前缀。 */
  annotated?: boolean
  /** 发起时的输入图数量：重试时判定「输入图已丢失」，拒绝静默退化成文生图。 */
  inputCount?: number
  /** 发起时的参数快照（已折叠 n=1），供重试 / 恢复 / 落历史保真复用。 */
  params?: TaskParams
  /** 发起时的 profile 身份快照，恢复完成落历史保真（缺失兜底当前 active profile）。 */
  profileView?: CanvasProfileSnapshot
}

const PLACEHOLDER_KIND = 'generation-placeholder'

/** 占位框元素挂在 customData 上的完整载荷。 */
interface PlaceholderData {
  kind: typeof PLACEHOLDER_KIND
  status: CanvasTaskStatus
  message: string
  meta: CanvasTaskMeta
}

/** 占位框的业务视图：几何 + 状态 + 恢复元数据（屏蔽底层元素结构）。 */
export interface PlaceholderView {
  id: string
  x: number
  y: number
  w: number
  h: number
  status: CanvasTaskStatus
  message: string
  meta: CanvasTaskMeta
}

function placeholderData(el: ExcalidrawElement): PlaceholderData | null {
  const data = el.customData
  return data?.kind === PLACEHOLDER_KIND ? (data as unknown as PlaceholderData) : null
}

function toView(el: ExcalidrawElement, data: PlaceholderData): PlaceholderView {
  return {
    id: el.id,
    x: el.x,
    y: el.y,
    w: el.width,
    h: el.height,
    status: data.status,
    message: data.message,
    meta: data.meta,
  }
}

function dataUrlMimeType(dataUrl: string): BinaryFileData['mimeType'] {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return (match?.[1] ?? 'image/png') as BinaryFileData['mimeType']
}

const TO_IMAGE_APP_STATE = { exportBackground: true, viewBackgroundColor: '#ffffff' } as const

/**
 * Excalidraw 适配层：业务逻辑（选区分析 / 占位框 / 放图 / 栅格化）只面向本类，
 * 不直接触碰 ExcalidrawImperativeAPI——这是换库时唯一需要重写的 editor 抽象。
 */
export class CanvasEditor {
  constructor(readonly api: ExcalidrawImperativeAPI) {}

  // ===== 只读查询 =====

  getElements(): readonly NonDeletedExcalidrawElement[] {
    return this.api.getSceneElements()
  }

  getElement(id: string): NonDeletedExcalidrawElement | undefined {
    return this.getElements().find((el) => el.id === id)
  }

  /** 当前选中的元素 id（过滤掉 appState 里可能残留的已删除 id）。 */
  getSelectedIds(): string[] {
    const selected = this.api.getAppState().selectedElementIds
    return this.getElements()
      .filter((el) => selected[el.id])
      .map((el) => el.id)
  }

  /** 元素的页面坐标 AABB（含旋转）。元素不存在 → undefined。 */
  getElementPageBounds(id: string): Box | undefined {
    const el = this.getElement(id)
    if (!el) return undefined
    const [x1, y1, x2, y2] = getCommonBounds([el])
    return new Box(x1, y1, x2 - x1, y2 - y1)
  }

  /** 当前视口的页面坐标范围。 */
  getViewportPageBounds(): Box {
    const s = this.api.getAppState()
    const zoom = s.zoom.value
    return new Box(-s.scrollX, -s.scrollY, s.width / zoom, s.height / zoom)
  }

  isPlaceholder(el: ExcalidrawElement): boolean {
    return placeholderData(el) !== null
  }

  getPlaceholder(id: string): PlaceholderView | undefined {
    const el = this.getElement(id)
    if (!el) return undefined
    const data = placeholderData(el)
    return data ? toView(el, data) : undefined
  }

  getPlaceholders(): PlaceholderView[] {
    const views: PlaceholderView[] = []
    for (const el of this.getElements()) {
      const data = placeholderData(el)
      if (data) views.push(toView(el, data))
    }
    return views
  }

  /** 订阅画布任意变更（元素 / 选区 / 视口）。返回取消订阅函数。 */
  onChange(callback: () => void): () => void {
    return this.api.onChange(() => callback())
  }

  // ===== 变更 =====

  private commit(elements: readonly ExcalidrawElement[]): void {
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }

  /** 创建 loading 占位框（虚线矩形 + customData 载荷），返回元素 id。 */
  createPlaceholder(
    target: { x: number; y: number; w: number; h: number },
    meta: CanvasTaskMeta,
  ): string {
    const data: PlaceholderData = { kind: PLACEHOLDER_KIND, status: 'loading', message: '', meta }
    const [el] = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: target.x,
        y: target.y,
        width: target.w,
        height: target.h,
        strokeColor: STATUS_ACCENT.loading,
        strokeStyle: 'dashed',
        strokeWidth: 2,
        roughness: 0,
        backgroundColor: 'transparent',
        customData: data as unknown as Record<string, unknown>,
      },
    ])
    this.commit([...this.getElements(), el])
    return el.id
  }

  /** 更新占位框状态 / 消息 / meta（合并写回 customData，描边色随状态同步）。不存在则 no-op。 */
  updatePlaceholder(
    id: string,
    patch: { status?: CanvasTaskStatus; message?: string; meta?: Partial<CanvasTaskMeta> },
  ): void {
    let changed = false
    const next = this.getElements().map((el) => {
      const data = placeholderData(el)
      if (el.id !== id || !data) return el
      changed = true
      const merged: PlaceholderData = {
        ...data,
        status: patch.status ?? data.status,
        message: patch.message ?? data.message,
        meta: { ...data.meta, ...patch.meta },
      }
      return newElementWith(el, {
        strokeColor: STATUS_ACCENT[merged.status],
        customData: merged as unknown as Record<string, unknown>,
      })
    })
    if (changed) this.commit(next)
  }

  /** 删除元素（占位框被替换 / 重试时删旧）。不存在则 no-op。 */
  deleteElement(id: string): void {
    const elements = this.getElements()
    const next = elements.filter((el) => el.id !== id)
    if (next.length !== elements.length) this.commit(next)
  }

  /** 把一组 dataUrl 图片放到指定位置（文件 + image 元素一并创建），返回新元素 id 列表。 */
  placeImages(
    items: Array<{ dataUrl: string; x: number; y: number; width: number; height: number }>,
    meta?: Record<string, string>,
  ): string[] {
    if (items.length === 0) return []
    const files: BinaryFileData[] = []
    const skeletons = items.map((item) => {
      const fileId = crypto.randomUUID() as FileId
      files.push({
        id: fileId,
        dataURL: item.dataUrl as BinaryFileData['dataURL'],
        mimeType: dataUrlMimeType(item.dataUrl),
        created: Date.now(),
      })
      return {
        type: 'image' as const,
        fileId,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        status: 'saved' as const,
        customData: meta ? { ...meta } : undefined,
      }
    })
    this.api.addFiles(files)
    const els = convertToExcalidrawElements(skeletons)
    this.commit([...this.getElements(), ...els])
    return els.map((el) => el.id)
  }

  setSelectedElements(ids: string[]): void {
    this.api.updateScene({
      appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true as const])) },
    })
  }

  /** 平滑移动镜头到一组元素（结果落在视口外时的反馈）。 */
  scrollToElements(ids: string[]): void {
    const idSet = new Set(ids)
    const els = this.getElements().filter((el) => idSet.has(el.id))
    if (els.length === 0) return
    this.api.scrollToContent(els, { fitToContent: true, animate: true, duration: 320 })
  }

  /**
   * 把一组元素栅格化为 PNG dataUrl（白色不透明背景，避免上游模型收到透明通道）。
   * - `scale < 1` 用于低成本预览缩略图
   * - `bounds` 提供时把导出结果裁剪到该页面坐标范围（标注可能溢出图片范围时裁回图内）
   * - 被选元素若有绑定文字标签（容器 label），一并纳入渲染
   */
  async toImage(
    ids: string[],
    opts: { scale?: number; bounds?: Box } = {},
  ): Promise<string | null> {
    const scale = opts.scale ?? 1
    const idSet = new Set(ids)
    const elements = this.getElements().filter(
      (el) =>
        idSet.has(el.id) || (el.type === 'text' && el.containerId && idSet.has(el.containerId)),
    )
    if (elements.length === 0) return null

    const canvas = await exportToCanvas({
      elements,
      files: this.api.getFiles(),
      exportPadding: 0,
      appState: TO_IMAGE_APP_STATE,
      getDimensions: (w: number, h: number) => ({
        width: Math.max(1, Math.floor(w * scale)),
        height: Math.max(1, Math.floor(h * scale)),
        scale,
      }),
    })
    if (!opts.bounds) return canvas.toDataURL('image/png')

    // 导出画布覆盖 elements 的联合包围盒；把目标 bounds 映射回导出像素坐标裁剪。
    const [x1, y1] = getCommonBounds(elements)
    const cropped = document.createElement('canvas')
    cropped.width = Math.max(1, Math.round(opts.bounds.w * scale))
    cropped.height = Math.max(1, Math.round(opts.bounds.h * scale))
    const ctx = cropped.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cropped.width, cropped.height)
    ctx.drawImage(canvas, (x1 - opts.bounds.x) * scale, (y1 - opts.bounds.y) * scale)
    return cropped.toDataURL('image/png')
  }
}
