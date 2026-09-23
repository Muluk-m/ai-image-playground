/** 合成工具的版面计算。纯函数：先算出每张画在哪、画多大，越界在建画布之前就能判。 */

export interface Size {
  width: number
  height: number
}

export interface Placement {
  index: number
  x: number
  y: number
  width: number
  height: number
}

export interface Layout extends Size {
  placements: Placement[]
}

/**
 * 长图拼接：竖拼统一到最窄的宽度，横拼统一到最矮的高度——只缩不放，拼出来没有一张是糊的。
 */
export function stitchLayout(
  sizes: readonly Size[],
  direction: 'vertical' | 'horizontal',
  gap: number,
): Layout {
  const vertical = direction === 'vertical'
  const edge = Math.min(...sizes.map((size) => (vertical ? size.width : size.height)))
  let offset = 0
  const placements = sizes.map((size, index) => {
    const length = Math.round(
      vertical ? (size.height * edge) / size.width : (size.width * edge) / size.height,
    )
    const placement = vertical
      ? { index, x: 0, y: offset, width: edge, height: length }
      : { index, x: offset, y: 0, width: length, height: edge }
    offset += length + gap
    return placement
  })
  const total = offset - gap
  return vertical
    ? { width: edge, height: total, placements }
    : { width: total, height: edge, placements }
}

/** 宫格拼图的格子边长上限：再大只是把文件撑大，拼图本来就是给人一眼看全的。 */
export const COLLAGE_MAX_CELL = 1200

/** 宫格拼图：等大正方格，格子边长取所有图短边里最小的那个（不放大），四周与格间都留 `gap`。 */
export function collageLayout(sizes: readonly Size[], columns: number, gap: number): Layout {
  const cols = Math.max(1, Math.min(columns, sizes.length))
  const rows = Math.ceil(sizes.length / cols)
  const cell = Math.min(COLLAGE_MAX_CELL, ...sizes.map((size) => Math.min(size.width, size.height)))
  return {
    width: cols * cell + (cols + 1) * gap,
    height: rows * cell + (rows + 1) * gap,
    placements: sizes.map((_, index) => ({
      index,
      x: gap + (index % cols) * (cell + gap),
      y: gap + Math.floor(index / cols) * (cell + gap),
      width: cell,
      height: cell,
    })),
  }
}

/** 九宫格切图：可选先居中裁成正方形，再均分成 rows × cols 块；除不尽的边角像素丢掉。 */
export function sliceLayout(size: Size, rows: number, columns: number, squareFirst: boolean) {
  const side = Math.min(size.width, size.height)
  const base = squareFirst ? { width: side, height: side } : size
  const tileWidth = Math.floor(base.width / columns)
  const tileHeight = Math.floor(base.height / rows)
  const tiles: Placement[] = []
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++)
      tiles.push({
        index: tiles.length,
        x: col * tileWidth,
        y: row * tileHeight,
        width: tileWidth,
        height: tileHeight,
      })
  return {
    base,
    source: {
      x: Math.floor((size.width - base.width) / 2),
      y: Math.floor((size.height - base.height) / 2),
    },
    tiles,
  }
}
