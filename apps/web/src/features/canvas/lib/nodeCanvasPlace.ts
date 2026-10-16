import { type CanvasNode, canvasNodeRegistry } from '@image-playground/shared'

/** 文本卡的框是固定的。正文再短也不能把卡片缩成两个字，否则两侧加号会叠在字上。 */
export const TEXT_CARD_WIDTH = 300
export const TEXT_CARD_HEIGHT = 210

/** Display geometry is independent of media pixels; old documents remain unchanged on load. */
export function nodeCardSize(node: CanvasNode): { width: number; height: number } {
  if (node.type === 'image' || node.type === 'video') return canvasNodeRegistry.image.size
  if (node.type !== 'text') return { width: node.width, height: node.height }
  return {
    width: Math.max(node.width, TEXT_CARD_WIDTH),
    height: Math.max(node.height, TEXT_CARD_HEIGHT),
  }
}
