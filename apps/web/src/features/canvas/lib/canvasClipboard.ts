import { type CanvasDoc, type CanvasEl, newElementId } from './canvasDoc'

/**
 * 画布内部剪贴板（⌘C / ⌘V / ⌘D）：内存级，不进系统剪贴板。
 * 系统剪贴板的图片粘贴走 KonvaCanvas 的 paste 监听（importImages）；
 * 同一个 paste 事件里优先系统图片，其次内部剪贴板。
 * 占位框是任务身份，不参与复制。
 */

const PASTE_OFFSET = 24

interface ClipboardPayload {
  elements: CanvasEl[]
  files: Record<string, string>
}

let clipboard: ClipboardPayload | null = null

/** 复制当前选区（深拷贝 + 收集引用的图片文件）。返回复制的元素数。 */
export function copySelection(doc: CanvasDoc): number {
  const els = doc.elements.filter((el) => doc.selection.has(el.id) && el.type !== 'placeholder')
  if (els.length === 0) return 0
  const files: Record<string, string> = {}
  for (const el of els) {
    if (el.type === 'image' && doc.files[el.fileId]) files[el.fileId] = doc.files[el.fileId]
  }
  clipboard = { elements: structuredClone(els), files }
  return els.length
}

/** 把剪贴板内容粘贴回画布（新 id、整体偏移），粘贴结果成为新选区。 */
export function pasteClipboard(doc: CanvasDoc): string[] {
  if (!clipboard) return []
  const pasted = clipboard.elements.map((el) => cloneWithOffset(el, PASTE_OFFSET, PASTE_OFFSET))
  doc.addElements(pasted, { files: { ...clipboard.files } })
  doc.setSelection(pasted.map((el) => el.id))
  // 连续粘贴逐次错开：把剪贴板自身也位移一步
  clipboard = {
    elements: clipboard.elements.map((el) =>
      cloneWithOffset(el, PASTE_OFFSET, PASTE_OFFSET, el.id),
    ),
    files: clipboard.files,
  }
  return pasted.map((el) => el.id)
}

/** ⌘D：选区原地复制一份（偏移一步），等价 copy + paste 但不动剪贴板。 */
export function duplicateSelection(doc: CanvasDoc): string[] {
  const els = doc.elements.filter((el) => doc.selection.has(el.id) && el.type !== 'placeholder')
  if (els.length === 0) return []
  const dup = els.map((el) => cloneWithOffset(el, PASTE_OFFSET, PASTE_OFFSET))
  doc.addElements(dup)
  doc.setSelection(dup.map((el) => el.id))
  return dup.map((el) => el.id)
}

/** 深拷贝一个元素并整体位移；id 缺省重新生成（图片共享同一 fileId，位图不复制）。 */
function cloneWithOffset(el: CanvasEl, dx: number, dy: number, keepId?: string): CanvasEl {
  const clone = structuredClone(el)
  clone.id = keepId ?? newElementId()
  if (clone.type === 'freedraw') {
    clone.points = clone.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
  } else if (clone.type === 'arrow') {
    clone.points = [
      clone.points[0] + dx,
      clone.points[1] + dy,
      clone.points[2] + dx,
      clone.points[3] + dy,
    ]
  } else {
    clone.x += dx
    clone.y += dy
  }
  return clone
}
