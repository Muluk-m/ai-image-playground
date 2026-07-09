import Konva from 'konva'
import type { CanvasProfileSnapshot } from '../../../store'
import type { TaskParams } from '../../../types'
import {
  type CanvasDoc,
  type CanvasEl,
  type ImageEl,
  newElementId,
  type PlaceholderEl,
} from './canvasDoc'
import { Box } from './geometry'
import { loadImage } from './imageCache'
import { arrowProps, freedrawProps, imageProps, textProps } from './konvaShapes'

/** 占位框的可视状态：运行中 / 失败 / 失效（不可恢复）。 */
export type CanvasTaskStatus = 'loading' | 'error' | 'stale'

/** 占位框各状态的主题色（画布元素描边 + overlay 内容共用同一单源）。 */
export const STATUS_ACCENT: Record<CanvasTaskStatus, string> = {
  loading: '#3b82f6',
  error: '#ef4444',
  stale: '#f59e0b',
}

/**
 * 占位框的任务恢复元数据（决策 2）。存在占位框元素上、随画布持久化，
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

function toView(el: PlaceholderEl): PlaceholderView {
  return {
    id: el.id,
    x: el.x,
    y: el.y,
    w: el.width,
    h: el.height,
    status: el.status,
    message: el.message,
    meta: el.meta,
  }
}

/** 元素的页面坐标 AABB（图片含旋转）。选区分析 / 导出 / marquee 共用。 */
export function elementBounds(el: CanvasEl): Box {
  switch (el.type) {
    case 'image': {
      if (!el.rotation) return new Box(el.x, el.y, el.width, el.height)
      const rad = (el.rotation * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      // Konva rotation 绕节点原点（左上角）
      const corners = [
        [0, 0],
        [el.width, 0],
        [0, el.height],
        [el.width, el.height],
      ].map(([dx, dy]) => [el.x + dx * cos - dy * sin, el.y + dx * sin + dy * cos])
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const minX = Math.min(...xs)
      const minY = Math.min(...ys)
      return new Box(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY)
    }
    case 'freedraw':
    case 'arrow': {
      const pts = el.points
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i])
        maxX = Math.max(maxX, pts[i])
        minY = Math.min(minY, pts[i + 1])
        maxY = Math.max(maxY, pts[i + 1])
      }
      // 描边宽度 + 箭头头部的外扩余量
      const pad = el.type === 'arrow' ? Math.max(el.strokeWidth, 12) : el.strokeWidth / 2 + 2
      return new Box(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2)
    }
    case 'text':
    case 'placeholder':
      return new Box(el.x, el.y, el.width, el.height)
  }
}

/** 离屏导出用：元素 → imperative Konva 节点（与实时渲染共用同一份属性映射）。 */
async function buildExportNode(
  el: CanvasEl,
  files: Readonly<Record<string, string>>,
): Promise<Konva.Node | null> {
  switch (el.type) {
    case 'image': {
      const dataUrl = files[el.fileId]
      if (!dataUrl) return null
      return new Konva.Image({ image: await loadImage(el.fileId, dataUrl), ...imageProps(el) })
    }
    case 'freedraw':
      return new Konva.Line(freedrawProps(el))
    case 'arrow':
      return new Konva.Arrow(arrowProps(el))
    case 'text':
      return new Konva.Text(textProps(el))
    case 'placeholder':
      return null
  }
}

/** 相机平滑动画时长（scrollToElements）。 */
const CAMERA_ANIMATION_MS = 300

/**
 * 画布编辑器适配层：业务逻辑（选区分析 / 占位框 / 放图 / 栅格化）只面向本类。
 * 底层是自建 CanvasDoc + Konva 渲染——本类是换渲染引擎时唯一需要重写的抽象。
 */
export class CanvasEditor {
  constructor(readonly doc: CanvasDoc) {}

  // ===== 只读查询 =====

  getElements(): readonly CanvasEl[] {
    return this.doc.elements
  }

  getElement(id: string): CanvasEl | undefined {
    return this.doc.getElement(id)
  }

  getSelectedIds(): string[] {
    return [...this.doc.selection]
  }

  /** 元素的页面坐标 AABB（含旋转）。元素不存在 → undefined。 */
  getElementPageBounds(id: string): Box | undefined {
    const el = this.doc.getElement(id)
    return el ? elementBounds(el) : undefined
  }

  /** 当前视口的页面坐标范围。 */
  getViewportPageBounds(): Box {
    const { camera, viewport } = this.doc
    return new Box(camera.x, camera.y, viewport.width / camera.zoom, viewport.height / camera.zoom)
  }

  isPlaceholder(el: CanvasEl): boolean {
    return el.type === 'placeholder'
  }

  getPlaceholder(id: string): PlaceholderView | undefined {
    const el = this.doc.getElement(id)
    return el?.type === 'placeholder' ? toView(el) : undefined
  }

  getPlaceholders(): PlaceholderView[] {
    return this.doc.elements.filter((el) => el.type === 'placeholder').map(toView)
  }

  /** 订阅画布任意变更（元素 / 选区 / 相机）。返回取消订阅函数。 */
  onChange(callback: () => void): () => void {
    return this.doc.subscribe(callback)
  }

  // ===== 变更 =====

  /** 创建 loading 占位框（虚线矩形），返回元素 id。 */
  createPlaceholder(
    target: { x: number; y: number; w: number; h: number },
    meta: CanvasTaskMeta,
  ): string {
    const el: PlaceholderEl = {
      id: newElementId(),
      type: 'placeholder',
      x: target.x,
      y: target.y,
      width: target.w,
      height: target.h,
      status: 'loading',
      message: '',
      meta,
    }
    this.doc.addElements([el])
    return el.id
  }

  /** 更新占位框状态 / 消息 / meta。状态流转不入 undo 历史（非用户操作）。 */
  updatePlaceholder(
    id: string,
    patch: { status?: CanvasTaskStatus; message?: string; meta?: Partial<CanvasTaskMeta> },
  ): void {
    const el = this.doc.getElement(id)
    if (el?.type !== 'placeholder') return
    this.doc.updateElements([
      {
        id,
        patch: {
          status: patch.status ?? el.status,
          message: patch.message ?? el.message,
          meta: { ...el.meta, ...patch.meta },
        },
      },
    ])
  }

  /** 删除元素（占位框被替换 / 重试时删旧）。不存在则 no-op。 */
  deleteElement(id: string): void {
    this.doc.deleteElements([id])
  }

  /** 把一组 dataUrl 图片放到指定位置（文件 + image 元素一并创建），返回新元素 id 列表。 */
  placeImages(
    items: Array<{ dataUrl: string; x: number; y: number; width: number; height: number }>,
    meta?: Record<string, string>,
  ): string[] {
    if (items.length === 0) return []
    const files: Record<string, string> = {}
    const els: ImageEl[] = items.map((item) => {
      const fileId = newElementId()
      files[fileId] = item.dataUrl
      return {
        id: newElementId(),
        type: 'image',
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rotation: 0,
        fileId,
        ...(meta ? { meta: { ...meta } } : {}),
      }
    })
    this.doc.addElements(els, { files })
    return els.map((el) => el.id)
  }

  setSelectedElements(ids: string[]): void {
    this.doc.setSelection(ids)
  }

  /** 平滑移动镜头到一组元素（结果落在视口外时的反馈）。 */
  scrollToElements(ids: string[]): void {
    const idSet = new Set(ids)
    const els = this.doc.elements.filter((el) => idSet.has(el.id))
    if (els.length === 0) return
    const bounds = Box.Common(els.map(elementBounds))
    const { viewport } = this.doc
    const padding = 96
    const zoom = Math.min(
      1,
      (viewport.width - padding * 2) / bounds.w,
      (viewport.height - padding * 2) / bounds.h,
    )
    const clamped = Math.max(0.05, zoom)
    const target = {
      x: bounds.midX - viewport.width / clamped / 2,
      y: bounds.midY - viewport.height / clamped / 2,
      zoom: clamped,
    }
    this.animateCamera(target)
  }

  private animateCamera(target: { x: number; y: number; zoom: number }): void {
    const from = { ...this.doc.camera }
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / CAMERA_ANIMATION_MS)
      const ease = 1 - (1 - t) ** 3
      this.doc.setCamera({
        x: from.x + (target.x - from.x) * ease,
        y: from.y + (target.y - from.y) * ease,
        zoom: from.zoom + (target.zoom - from.zoom) * ease,
      })
      if (t < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /**
   * 把一组元素栅格化为 PNG dataUrl（白色不透明背景，避免上游模型收到透明通道）。
   * - `scale < 1` 用于低成本预览缩略图
   * - `bounds` 提供时裁剪到该页面坐标范围（标注溢出图片时裁回图内）；缺省取元素联合包围盒
   * 用离屏 Konva stage 渲染，与画布显示共用同一份属性映射，所见即所得。
   */
  async toImage(
    ids: string[],
    opts: { scale?: number; bounds?: Box } = {},
  ): Promise<string | null> {
    const scale = opts.scale ?? 1
    const idSet = new Set(ids)
    const els = this.doc.elements.filter((el) => idSet.has(el.id) && el.type !== 'placeholder')
    if (els.length === 0) return null
    const bounds = opts.bounds ?? Box.Common(els.map(elementBounds))

    const container = document.createElement('div')
    const stage = new Konva.Stage({
      container,
      width: Math.max(1, Math.round(bounds.w * scale)),
      height: Math.max(1, Math.round(bounds.h * scale)),
    })
    try {
      const layer = new Konva.Layer()
      stage.add(layer)
      layer.add(
        new Konva.Rect({
          x: bounds.x,
          y: bounds.y,
          width: bounds.w,
          height: bounds.h,
          fill: '#ffffff',
        }),
      )
      const nodes = await Promise.all(els.map((el) => buildExportNode(el, this.doc.files)))
      for (const node of nodes) {
        if (node) layer.add(node as Konva.Shape)
      }
      stage.scale({ x: scale, y: scale })
      stage.position({ x: -bounds.x * scale, y: -bounds.y * scale })
      layer.draw()
      return stage.toDataURL({ mimeType: 'image/png', pixelRatio: 1 })
    } finally {
      stage.destroy()
    }
  }
}
