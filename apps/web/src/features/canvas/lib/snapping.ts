import type { CanvasEl } from './canvasDoc'
import { type CanvasEditor, elementBounds } from './editor'
import { Box } from './geometry'

/**
 * 拖拽吸附对齐（tldraw 风格）：选区包围盒的边 / 中心贴近其他元素的
 * 边 / 中心时，把位移吸到对齐位置并给出参考线。纯几何计算，
 * 拖拽手势层（KonvaCanvas）在 dragstart 建目标、dragmove 逐帧求解。
 */

/** 单条对齐参考线：axis 为 'x' 表示竖线（x=value），线段范围 [from, to]。 */
export interface SnapGuide {
  axis: 'x' | 'y'
  value: number
  from: number
  to: number
}

interface SnapEdge {
  value: number
  box: Box
}

export interface SnapTargets {
  xs: SnapEdge[]
  ys: SnapEdge[]
}

/** 收集吸附目标：除拖拽选区外所有元素的 左/中/右 与 上/中/下。 */
export function buildSnapTargets(
  elements: readonly CanvasEl[],
  excludeIds: Set<string>,
): SnapTargets {
  const xs: SnapEdge[] = []
  const ys: SnapEdge[] = []
  for (const el of elements) {
    if (excludeIds.has(el.id)) continue
    const box = elementBounds(el)
    xs.push({ value: box.x, box }, { value: box.midX, box }, { value: box.maxX, box })
    ys.push({ value: box.y, box }, { value: box.midY, box }, { value: box.maxY, box })
  }
  return { xs, ys }
}

function nearestEdge(
  edges: SnapEdge[],
  candidates: number[],
  threshold: number,
): { delta: number; edge: SnapEdge } | null {
  let best: { delta: number; edge: SnapEdge } | null = null
  for (const edge of edges) {
    for (const c of candidates) {
      const delta = edge.value - c
      if (Math.abs(delta) >= threshold) continue
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, edge }
    }
  }
  return best
}

/**
 * 求解吸附：给定选区拖动到的包围盒，若某轴上边/中/边贴近目标则修正该轴位移。
 * 返回修正量（加到原始 dx/dy 上）与吸中后的参考线（跨越选区与目标的联合范围）。
 */
export function resolveSnap(
  targets: SnapTargets,
  moved: Box,
  threshold: number,
): { adjustX: number; adjustY: number; guides: SnapGuide[] } {
  const bestX = nearestEdge(targets.xs, [moved.x, moved.midX, moved.maxX], threshold)
  const bestY = nearestEdge(targets.ys, [moved.y, moved.midY, moved.maxY], threshold)
  const adjustX = bestX?.delta ?? 0
  const adjustY = bestY?.delta ?? 0
  const snapped = new Box(moved.x + adjustX, moved.y + adjustY, moved.w, moved.h)

  const guides: SnapGuide[] = []
  if (bestX) {
    guides.push({
      axis: 'x',
      value: bestX.edge.value,
      from: Math.min(snapped.y, bestX.edge.box.y),
      to: Math.max(snapped.maxY, bestX.edge.box.maxY),
    })
  }
  if (bestY) {
    guides.push({
      axis: 'y',
      value: bestY.edge.value,
      from: Math.min(snapped.x, bestY.edge.box.x),
      to: Math.max(snapped.maxX, bestY.edge.box.maxX),
    })
  }
  return { adjustX, adjustY, guides }
}

/** 选区的联合包围盒（dragstart 时记一次，之后按位移平移）。 */
export function selectionBounds(editor: CanvasEditor, ids: Iterable<string>): Box | null {
  const boxes: Box[] = []
  for (const id of ids) {
    const el = editor.getElement(id)
    if (el) boxes.push(elementBounds(el))
  }
  return boxes.length > 0 ? Box.Common(boxes) : null
}
