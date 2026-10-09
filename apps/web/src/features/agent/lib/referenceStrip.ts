/** 没量到栏宽时先按这个数折，避免整面胶囊先画出来。 */
export const REFERENCE_ROW_FALLBACK = 8

/**
 * 图片胶囊的固定占位：1px 边框 + 2px 左内边距 + 1.5rem 缩略图 + 5px 间距 + 6px 右内边距 + 1px 边框。
 * 和 `.mention-tag.agent-image-mention` 对齐；名字另算，并且不超过 9rem。
 * 缩略图按 rem 走，用户调大浏览器默认字号时跟着变宽，所以按根字号换算。
 */
export function referenceChipChrome(rootFontSize: number): number {
  return 15 + rootFontSize * 1.5
}

/**
 * 「还有 N 张」的固定占位：边框、左右 8px 内边距、4px 间距和 0.875rem 图标。
 * 和 `.mention-tag.agent-reference-fold` 对齐。
 */
export function referenceFoldChrome(rootFontSize: number): number {
  return 22 + rootFontSize * 0.875
}

/**
 * 一行里最多放下几张胶囊，还要给折叠按钮留位置。
 * 放得下全部就全部留下，按钮不出现。一张都放不下时返回 0，只留计数按钮。
 * `available <= 0` 表示还没量到宽度，退回 `fallback`。
 */
export function fitReferenceRow(
  available: number,
  chipWidths: readonly number[],
  moreWidth: (hidden: number) => number,
  gap: number,
  fallback: number,
): number {
  const total = chipWidths.length
  if (total === 0) return 0
  if (!(available > 0)) return Math.min(Math.max(fallback, 0), total)

  const row = (count: number) => {
    let width = 0
    for (let index = 0; index < count; index += 1) width += chipWidths[index] ?? 0
    if (count > 1) width += gap * (count - 1)
    return width
  }

  if (row(total) <= available) return total

  let fitted = 0
  for (let count = 1; count < total; count += 1) {
    if (row(count) + gap + moreWidth(total - count) > available) break
    fitted = count
  }
  return fitted
}
