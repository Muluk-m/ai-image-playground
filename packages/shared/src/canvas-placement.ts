import type { CanvasNode } from './canvas-document'
import { canvasNodeRegistry } from './canvas-registry'

/** 文本卡的框是固定的。正文再短也不能把卡片缩成两个字，否则两侧加号会叠在字上。 */
export const TEXT_CARD_WIDTH = 300
export const TEXT_CARD_HEIGHT = 210
const MEDIA_CARD_WIDTH = 360
const MEDIA_CARD_HEIGHT = 240

/** 图片/视频卡在最大工作区内保持素材比例，不能用固定框裁剪原图。 */
export function nodeCardSize(node: CanvasNode): { width: number; height: number } {
  if (node.type === 'image' || node.type === 'video') {
    const data = node.data
    const naturalWidth =
      'naturalWidth' in data && typeof data.naturalWidth === 'number'
        ? data.naturalWidth
        : undefined
    const naturalHeight =
      'naturalHeight' in data && typeof data.naturalHeight === 'number'
        ? data.naturalHeight
        : undefined
    if (
      naturalWidth !== undefined &&
      naturalHeight !== undefined &&
      Number.isFinite(naturalWidth) &&
      Number.isFinite(naturalHeight) &&
      naturalWidth > 0 &&
      naturalHeight > 0
    ) {
      const scale = Math.min(1, MEDIA_CARD_WIDTH / naturalWidth, MEDIA_CARD_HEIGHT / naturalHeight)
      return {
        width: Math.max(1, Math.round(naturalWidth * scale)),
        height: Math.max(1, Math.round(naturalHeight * scale)),
      }
    }
    return { width: MEDIA_CARD_WIDTH, height: MEDIA_CARD_HEIGHT }
  }
  if (node.type !== 'text') return { width: node.width, height: node.height }
  return {
    width: Math.max(node.width, TEXT_CARD_WIDTH),
    height: Math.max(node.height, TEXT_CARD_HEIGHT),
  }
}

interface CanvasPlacementRect {
  x: number
  y: number
  width: number
  height: number
}

/** Translate a pre-arranged batch into free space without moving existing nodes or its members. */
export function findFreeCanvasPlacement(
  proposed: readonly CanvasPlacementRect[],
  occupied: readonly CanvasPlacementRect[],
  gap: number,
): { x: number; y: number } {
  if (proposed.length === 0) return { x: 0, y: 0 }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of proposed) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  let y = 0
  // Each jump clears a blocking node permanently; the search terminates below the last blocker.
  for (;;) {
    let nextY = y
    for (const rect of occupied) {
      if (
        left < rect.x + rect.width + gap &&
        right + gap > rect.x &&
        top + y < rect.y + rect.height + gap &&
        bottom + y + gap > rect.y
      ) {
        nextY = Math.max(nextY, rect.y + rect.height + gap - top)
      }
    }
    if (nextY === y) return { x: 0, y }
    y = nextY
  }
}
