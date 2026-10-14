/** 缩放到这个值及以上，视口里的节点用完整卡片。再小就只留标题块。 */
export const CANVAS_LOD_DETAIL_ZOOM = 0.5

/** 一次挂进 DOM 的节点上限。超出后改画总览，不再铺开节点。 */
export const CANVAS_LOD_MOUNT_LIMIT = 80

/** 视口外再多留的世界坐标，除以缩放后变成提前挂载的边距。 */
const VIEW_MARGIN = 240

export type CanvasLodMode = 'detail' | 'card' | 'overview'

export interface CanvasViewportBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasViewportLink {
  id: string
  source: string
  target: string
}

export interface CanvasViewportFrame {
  x: number
  y: number
  zoom: number
  width: number
  height: number
}

export interface CanvasViewportPlan {
  mode: CanvasLodMode
  /** 真正挂成 DOM 的 id。总览里只有钉住的节点，并且不超过挂载上限。 */
  mountedIds: readonly string[]
  /** 总览画布要画的盒子。细看和标题块模式为空，节点交给 React Flow。 */
  painted: readonly CanvasViewportBox[]
  /** 两端都落在当前绘制集合里的边。 */
  visibleEdgeIds: readonly string[]
}

function finiteBox(box: CanvasViewportBox): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite)
}

function intersects(
  box: CanvasViewportBox,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  return box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top
}

function edgeIds(edges: readonly CanvasViewportLink[], ids: ReadonlySet<string>): string[] {
  const visible: string[] = []
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) visible.push(edge.id)
  }
  return visible
}

function cappedPins(pinnedIds: readonly string[], known: ReadonlySet<string>): string[] {
  const mounted: string[] = []
  const seen = new Set<string>()
  for (const id of pinnedIds) {
    if (mounted.length >= CANVAS_LOD_MOUNT_LIMIT) break
    if (!known.has(id) || seen.has(id)) continue
    seen.add(id)
    mounted.push(id)
  }
  return mounted
}

/**
 * 总览画的是文档坐标。拖动时 React 状态里的位置已经变了，但文档要等松手才写入。
 * 用实时坐标盖住同一批盒子，组里的节点才会跟着组框走。尺寸仍用文档里的。
 */
export function withLivePositions(
  items: readonly CanvasViewportBox[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
): readonly CanvasViewportBox[] {
  let changed = false
  const next = items.map((item) => {
    const position = positions.get(item.id)
    if (!position || (position.x === item.x && position.y === item.y)) return item
    changed = true
    return { ...item, x: position.x, y: position.y }
  })
  return changed ? next : items
}

function plan(
  mode: CanvasLodMode,
  mountedIds: readonly string[],
  painted: readonly CanvasViewportBox[],
  edges: readonly CanvasViewportLink[],
  connected: ReadonlySet<string>,
): CanvasViewportPlan {
  return { mode, mountedIds, painted, visibleEdgeIds: edgeIds(edges, connected) }
}

/**
 * 决定这一帧挂哪些节点。
 * 缩放够大且视口里的数量不超过上限时用完整节点；缩小但数量仍够少时用标题块；
 * 再多就只钉住选中和正在拖的节点，其余画到一张总览上。
 * 视口还没量出来、节点又已经超过上限时直接进总览，避免先挂出几千个 DOM。
 */
export function planCanvasViewport(input: {
  items: readonly CanvasViewportBox[]
  edges: readonly CanvasViewportLink[]
  frame: CanvasViewportFrame
  pinnedIds?: readonly string[]
}): CanvasViewportPlan {
  const { items, edges, frame } = input
  const pinnedIds = input.pinnedIds ?? []
  const zoom = frame.zoom
  const unmeasured =
    !(frame.width > 0) || !(frame.height > 0) || !(zoom > 0) || !Number.isFinite(zoom)
  if (unmeasured) {
    if (items.length > CANVAS_LOD_MOUNT_LIMIT) {
      const known = new Set(items.filter(finiteBox).map((item) => item.id))
      return plan('overview', cappedPins(pinnedIds, known), [], edges, new Set())
    }
    const visible = items.filter(finiteBox)
    const ids = new Set(visible.map((item) => item.id))
    const mode = zoom >= CANVAS_LOD_DETAIL_ZOOM ? 'detail' : 'card'
    return plan(
      mode,
      visible.map((item) => item.id),
      [],
      edges,
      ids,
    )
  }

  const margin = VIEW_MARGIN / zoom
  const left = (0 - frame.x) / zoom - margin
  const top = (0 - frame.y) / zoom - margin
  const right = (frame.width - frame.x) / zoom + margin
  const bottom = (frame.height - frame.y) / zoom + margin
  const visible: CanvasViewportBox[] = []
  for (const item of items) {
    if (finiteBox(item) && intersects(item, left, top, right, bottom)) visible.push(item)
  }
  if (visible.length > CANVAS_LOD_MOUNT_LIMIT) {
    const known = new Set<string>()
    for (const item of items) if (finiteBox(item)) known.add(item.id)
    const paintedIds = new Set(visible.map((item) => item.id))
    return plan('overview', cappedPins(pinnedIds, known), visible, edges, paintedIds)
  }
  const ids = visible.map((item) => item.id)
  const mode = zoom >= CANVAS_LOD_DETAIL_ZOOM ? 'detail' : 'card'
  return plan(mode, ids, [], edges, new Set(ids))
}
