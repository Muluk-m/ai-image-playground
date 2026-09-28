/**
 * 整理画布的纯几何：智能体只决定分组和页签，位置在这里算成绝对值。
 * 结果写进 `AgentCanvasEdit` 再交给画布，重放同一条结果不会再挪一次。
 */

/** 卡片上方那一行小字。 */
export const ARRANGE_CAPTION_FONT = 15
/** 一组左上角那行稍大的页签。 */
export const ARRANGE_SECTION_FONT = 18
export const ARRANGE_LABEL_LINE = 1.3
/** 页签文字和下一行（小字或图片）之间的空隙。 */
export const ARRANGE_LABEL_GAP = 6
export const ARRANGE_CAPTION_MAX = 24
export const ARRANGE_SECTION_MAX = 24
/** 一次整理最多搬多少张。再多就让模型拆成两次，避免一条结果盖住整张画布。 */
export const ARRANGE_MAX_ITEMS = 80

export function arrangeCaptionHeight(): number {
  return ARRANGE_CAPTION_FONT * ARRANGE_LABEL_LINE + ARRANGE_LABEL_GAP
}

export function arrangeSectionHeight(): number {
  return ARRANGE_SECTION_FONT * ARRANGE_LABEL_LINE + ARRANGE_LABEL_GAP
}

export interface ArrangeBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ArrangeGroupInput {
  readonly label?: string
  readonly columns?: number
  readonly items: readonly { readonly elementId: string; readonly caption?: string }[]
}

export interface ArrangePlacement {
  readonly elementId: string
  readonly x: number
  readonly y: number
  /** 缺席表示这张图的名字不动。 */
  readonly caption?: string
  /** 空串表示清掉这张图上的组页签。 */
  readonly section: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clean(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 360
}

function union(boxes: readonly ArrangeBox[]): { x: number; y: number; maxX: number } {
  let x = Number.POSITIVE_INFINITY
  let y = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    maxX = Math.max(maxX, box.x + box.w)
  }
  return { x, y, maxX }
}

function columnCount(requested: number | undefined, count: number): number {
  const auto = Math.max(1, Math.ceil(Math.sqrt(count)))
  const chosen = requested !== undefined && requested >= 1 ? Math.floor(requested) : auto
  return Math.max(1, Math.min(chosen, count))
}

/**
 * 把各组收成格子，整批放到「没被点到的内容」右侧。
 * 组与组之间留出能单独框选的空档；每张图上方留出页签的高度，小字才不会压到上一行。
 * 点到的图如果画布上没有对应的盒子，就跳过——调用方负责告诉模型哪些 id 没排进去。
 */
export function layoutCanvasArrange(
  groups: readonly ArrangeGroupInput[],
  boxes: readonly ArrangeBox[],
): ArrangePlacement[] {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const seen = new Set<string>()
  const planned: { elementId: string; caption?: string; section: string; box: ArrangeBox }[] = []
  const blocks: { start: number; count: number; columns: number; section: boolean }[] = []

  for (const group of groups) {
    const label = clean(group.label, ARRANGE_SECTION_MAX)
    const members: typeof planned = []
    for (const item of group.items) {
      if (seen.has(item.elementId)) continue
      const box = byId.get(item.elementId)
      if (!box || box.w <= 0 || box.h <= 0) continue
      seen.add(item.elementId)
      members.push({
        elementId: item.elementId,
        ...(clean(item.caption, ARRANGE_CAPTION_MAX)
          ? { caption: clean(item.caption, ARRANGE_CAPTION_MAX) }
          : {}),
        section: '',
        box,
      })
    }
    if (members.length === 0) continue
    if (label) members[0] = { ...members[0]!, section: label }
    blocks.push({
      start: planned.length,
      count: members.length,
      columns: columnCount(group.columns, members.length),
      section: Boolean(label),
    })
    planned.push(...members)
  }
  if (planned.length === 0) return []

  const moving = planned.map((item) => item.box)
  const movingBox = union(moving)
  const obstacles = boxes.filter((box) => !seen.has(box.id))
  const shortSide = median(moving.map((box) => Math.min(box.w, box.h)))
  const cellGap = clamp(shortSide * 0.22, 96, 200)
  const groupGap = clamp(shortSide * 0.5, 160, 280)
  const captionH = arrangeCaptionHeight()
  // 横坐标让到其余内容的右边；纵坐标留在这批图现在的高度，不跟画布最顶上的一只箭头跑。
  let cursorX = obstacles.length > 0 ? union(obstacles).maxX + groupGap : movingBox.x
  const originY = movingBox.y

  const placed = new Map<string, { x: number; y: number }>()
  for (const block of blocks) {
    const members = planned.slice(block.start, block.start + block.count)
    const columns = block.columns
    const colW = Array.from({ length: columns }, () => 0)
    const rowCount = Math.ceil(members.length / columns)
    const rowH = Array.from({ length: rowCount }, () => 0)
    members.forEach((item, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      colW[column] = Math.max(colW[column] ?? 0, item.box.w)
      rowH[row] = Math.max(rowH[row] ?? 0, item.box.h)
    })
    const sectionH = block.section ? arrangeSectionHeight() : 0
    let rowTop = originY + sectionH
    for (let row = 0; row < rowCount; row += 1) {
      let x = cursorX
      for (let column = 0; column < columns; column += 1) {
        const item = members[row * columns + column]
        if (!item) break
        placed.set(item.elementId, { x, y: rowTop + captionH })
        x += (colW[column] ?? 0) + cellGap
      }
      rowTop += captionH + (rowH[row] ?? 0) + cellGap
    }
    const width = colW.reduce((sum, one) => sum + one, 0) + cellGap * Math.max(0, columns - 1)
    cursorX += width + groupGap
  }

  return planned.flatMap((item) => {
    const at = placed.get(item.elementId)
    if (!at) return []
    return [
      {
        elementId: item.elementId,
        x: at.x,
        y: at.y,
        ...(item.caption ? { caption: item.caption } : {}),
        section: item.section,
      },
    ]
  })
}
