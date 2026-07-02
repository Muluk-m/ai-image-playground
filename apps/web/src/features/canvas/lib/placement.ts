import type { Box, Editor } from 'tldraw'

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
 * n>1 变体 fan-out 的占位目标：以 base 为首，沿水平方向依次排开，彼此留间距。
 * 与工作台「n 张拆 n 条任务」语义一致，画布上表现为一排独立占位框。
 */
export function fanOutTargets(base: PlacementTarget, n: number): PlacementTarget[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => ({
    ...base,
    x: base.x + i * (base.w + PLACEMENT_GAP),
  }))
}

/**
 * 计算占位框目标位置（抽成独立函数，便于未来换动态寻空位）：
 * - 有选区：选区包围盒右侧、垂直居中于包围盒
 * - 无选区（文生图）：当前视口中心
 */
export function computePlaceholderTarget(
  editor: Editor,
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
