/** 最短列优先的瀑布流。比例是高/宽，布局时夹在 0.56–1.9。 */
export const MASONRY_CAPTION_HEIGHT = 46
export const MASONRY_GAP = 12
export const MASONRY_GAP_COMPACT = 10
export const MASONRY_BATCH = 30
export const RATIO_MIN = 0.56
export const RATIO_MAX = 1.9
const FALLBACK_RATIO = 3 / 4

export function columnsForWidth(width: number): number {
  if (width > 1500) return 6
  if (width > 1100) return 5
  if (width > 740) return 4
  if (width > 520) return 3
  return 2
}

export function clampRatio(heightOverWidth: number): number {
  if (!Number.isFinite(heightOverWidth) || heightOverWidth <= 0) return FALLBACK_RATIO
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, heightOverWidth))
}

export interface MasonryBox {
  index: number
  x: number
  y: number
  width: number
  imageHeight: number
}

export interface MasonryLayout {
  columns: number
  columnWidth: number
  height: number
  boxes: MasonryBox[]
}

/** 输入容器宽度和每张卡的高/宽，输出绝对定位坐标。 */
export function layoutMasonry(
  width: number,
  ratios: readonly number[],
  gap = MASONRY_GAP,
  captionHeight = MASONRY_CAPTION_HEIGHT,
): MasonryLayout {
  const columns = columnsForWidth(width)
  const safeWidth = Number.isFinite(width) ? Math.max(width, 0) : 0
  const columnWidth = Math.max(0, (safeWidth - gap * (columns - 1)) / columns)
  const heights = Array.from({ length: columns }, () => 0)
  const boxes: MasonryBox[] = ratios.map((ratio, index) => {
    let column = 0
    for (let next = 1; next < columns; next += 1) {
      if (heights[next]! < heights[column]!) column = next
    }
    const imageHeight = columnWidth * clampRatio(ratio)
    const box: MasonryBox = {
      index,
      x: column * (columnWidth + gap),
      y: heights[column]!,
      width: columnWidth,
      imageHeight,
    }
    heights[column] = heights[column]! + imageHeight + captionHeight + gap
    return box
  })
  const height = ratios.length === 0 ? 0 : Math.max(...heights) - gap
  return { columns, columnWidth, height, boxes }
}
