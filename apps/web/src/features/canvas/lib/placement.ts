import type { CanvasEditor } from './editor'
import { Box } from './geometry'

/** 结果 / 占位框与源选区之间、以及多张结果彼此之间的留白（页面坐标单位）。 */
export const PLACEMENT_GAP = 48

/** 尚不知结果真实尺寸时占位框的默认边长（页面坐标单位）。 */
const DEFAULT_TARGET_SIZE = 360

export interface PlacementTarget {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 把原始尺寸按 contain 适配进 target 框（保持宽高比，可放大可缩小）：
 * 生成结果 / 送进画布的图以此落成与展位框一致的大小，而非原始像素尺寸。
 */
export function fitToTarget(
  width: number,
  height: number,
  frame: { w: number; h: number },
): { w: number; h: number } {
  const scale = Math.min(frame.w / width, frame.h / height)
  return { w: width * scale, h: height * scale }
}

/**
 * 空位搜索的起点：
 * - 有锚点（选区 / 改图的源图）：锚点包围盒右侧、垂直居中于包围盒
 * - 无锚点（文生图）：当前视口中心
 * 这里只给出「理想位置」，是否被占由 `findFreeTarget` 判。
 */
export function computePlaceholderTarget(
  editor: CanvasEditor,
  selectionBounds: Box | null,
): PlacementTarget {
  const size = DEFAULT_TARGET_SIZE
  if (selectionBounds) {
    return {
      x: selectionBounds.maxX + PLACEMENT_GAP,
      y: selectionBounds.midY - size / 2,
      w: size,
      h: size,
    }
  }
  const viewport = editor.getViewportPageBounds()
  return { x: viewport.midX - size / 2, y: viewport.midY - size / 2, w: size, h: size }
}

export function boxOfTarget(target: PlacementTarget): Box {
  return new Box(target.x, target.y, target.w, target.h)
}

/** 一行横向能铺到哪：`x` 是行首，`width` 是从行首起算的可用宽度。 */
export interface PlacementRow {
  readonly x: number
  readonly width: number
}

/** 搜索的横向步数与换行次数上限；超出即走「落到所有元素下方」的兜底，保证函数一定返回空位。 */
const MAX_STEPS_PER_ROW = 64
const MAX_ROWS = 64

function bottomOf(obstacles: readonly Box[]): number {
  return obstacles.reduce((lowest, one) => Math.max(lowest, one.maxY), Number.NEGATIVE_INFINITY)
}

/**
 * 从 `start` 出发找一个与任何障碍物都不相交的同尺寸位置（纯几何，不碰画布）：
 * 被挡就跳到挡路者右边界加一个 `PLACEMENT_GAP` 继续试；这一行放不下就回到行首、
 * 往下挪一行再来。行列都走完（画布密到离谱）时落到所有元素下方——那里一定是空的。
 */
export function findFreeTarget(
  start: PlacementTarget,
  obstacles: readonly Box[],
  row: PlacementRow,
): PlacementTarget {
  const limitX = row.x + Math.max(row.width, start.w)
  let y = start.y
  for (let attempt = 0; attempt < MAX_ROWS; attempt += 1) {
    let x = attempt === 0 ? start.x : row.x
    for (let step = 0; step < MAX_STEPS_PER_ROW; step += 1) {
      const candidate = { ...start, x, y }
      const blocked = obstacles.find((one) => one.collides(boxOfTarget(candidate)))
      if (!blocked) return candidate
      const next = blocked.maxX + PLACEMENT_GAP
      if (next + start.w > limitX) break
      x = next
    }
    y += start.h + PLACEMENT_GAP
  }
  return { ...start, x: row.x, y: bottomOf(obstacles) + PLACEMENT_GAP }
}

/**
 * 一次生成要占的 n 个目标位置：从锚点右侧（无锚点则视口中心）起，依次找互不重叠、
 * 也不压住画布上任何已有元素的空位。直接生成与智能体两条路共用这一个入口，
 * 所以「多张排开」与「避让已有元素」两边行为一致。
 */
export function computePlaceholderTargets(
  editor: CanvasEditor,
  anchorBounds: Box | null,
  count: number,
): PlacementTarget[] {
  const base = computePlaceholderTarget(editor, anchorBounds)
  const viewport = editor.getViewportPageBounds()
  const row: PlacementRow = { x: base.x, width: viewport.w }
  const obstacles = editor.getOccupiedBounds()
  const targets: PlacementTarget[] = []
  let start = base
  for (let index = 0; index < Math.max(1, count); index += 1) {
    const target = findFreeTarget(start, obstacles, row)
    targets.push(target)
    obstacles.push(boxOfTarget(target))
    // 下一个从上一个右边一个间距处起步：画布空时退化成一排等距占位框。
    start = { ...base, x: target.x + target.w + PLACEMENT_GAP, y: target.y }
  }
  return targets
}
