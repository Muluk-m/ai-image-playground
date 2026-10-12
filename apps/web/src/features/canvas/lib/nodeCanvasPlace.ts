import { newElementId, type TextEl } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { measureText } from './konvaShapes'

/** 节点上的正文，不是标注那套大红字。 */
const NODE_TEXT_FONT_SIZE = 32

/** 在双击的位置放一个空文本节点，调用方接着让它进入编辑。 */
export function placeNodeText(
  editor: CanvasEditor,
  point: { x: number; y: number },
  fill: string,
): string {
  const box = measureText(' ', NODE_TEXT_FONT_SIZE)
  const el: TextEl = {
    id: newElementId(),
    type: 'text',
    x: point.x,
    y: point.y,
    text: '',
    fontSize: NODE_TEXT_FONT_SIZE,
    fill,
    width: Math.max(box.width, 160),
    height: box.height,
  }
  editor.doc.addElements([el])
  editor.doc.setEditingText(el.id)
  return el.id
}

/** 空文本当作取消；有内容才写回，并记进撤销。 */
export function commitNodeText(editor: CanvasEditor, id: string, raw: string): void {
  const el = editor.doc.getElement(id)
  if (el?.type !== 'text') return
  const text = raw.replace(/\u00a0/g, ' ')
  editor.doc.setEditingText(null)
  if (!text.trim()) {
    editor.doc.deleteElements([id])
    return
  }
  const box = measureText(text, el.fontSize)
  editor.doc.updateElements([{ id, patch: { text, width: box.width, height: box.height } }], {
    history: true,
  })
}
