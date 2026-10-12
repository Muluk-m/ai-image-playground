import { canvasOrigin, insertCanvasNode } from '@image-playground/shared'
import type * as Y from 'yjs'
import { newElementId, type TextEl } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { measureText } from './konvaShapes'

const EMPTY_IMAGE_NODE = 280
/** 空卡片不是用户撤销栈上的一步，避免生成完再撤销把整张卡撤掉。 */
const insertOrigin = canvasOrigin('system', 'node-insert')

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
    width: Math.max(box.width, 200),
    height: Math.max(box.height, 72),
  }
  editor.doc.addElements([el])
  return el.id
}

/** 在双击的位置放一张空图片卡，接着由节点下面的输入框生成或上传。 */
export function placeEmptyImageNode(doc: Y.Doc, point: { x: number; y: number }): string {
  const id = newElementId()
  insertCanvasNode(
    doc,
    {
      id,
      type: 'image',
      x: point.x - EMPTY_IMAGE_NODE / 2,
      y: point.y - EMPTY_IMAGE_NODE / 2,
      width: EMPTY_IMAGE_NODE,
      height: EMPTY_IMAGE_NODE,
      data: {},
    },
    insertOrigin,
  )
  return id
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
