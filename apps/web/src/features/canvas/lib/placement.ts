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
