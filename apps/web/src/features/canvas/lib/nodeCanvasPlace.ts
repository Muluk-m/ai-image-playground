import {
  type CanvasNode,
  canvasOrigin,
  connectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { newElementId, type TextEl } from './canvasDoc'
import type { CanvasEditor } from './editor'

const EMPTY_IMAGE_NODE = 280
/** 文本卡的框是固定的。正文再短也不能把卡片缩成两个字，否则两侧加号会叠在字上。 */
export const TEXT_CARD_WIDTH = 300
export const TEXT_CARD_HEIGHT = 210
/** 空卡片不是用户撤销栈上的一步，避免生成完再撤销把整张卡撤掉。 */
const insertOrigin = canvasOrigin('system', 'node-insert')

/** 节点上的正文，不是标注那套大红字。卡片自己用界面字号，这里只留给旧画布。 */
const NODE_TEXT_FONT_SIZE = 16

/** 在双击的位置放一张空文本卡。双击卡片再改字，框的大小不动。 */
export function placeNodeText(
  editor: CanvasEditor,
  point: { x: number; y: number },
  fill: string,
): string {
  const el: TextEl = {
    id: newElementId(),
    type: 'text',
    x: point.x - TEXT_CARD_WIDTH / 2,
    y: point.y - TEXT_CARD_HEIGHT / 2,
    text: '',
    fontSize: NODE_TEXT_FONT_SIZE,
    fill,
    width: TEXT_CARD_WIDTH,
    height: TEXT_CARD_HEIGHT,
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

/** 两张卡之间留出两侧加号（各 42px）再加一段能看见的连线。 */
const SPAWN_GAP = 168

function cardSize(node: CanvasNode): { width: number; height: number } {
  if (node.type !== 'text') return { width: node.width, height: node.height }
  return {
    width: Math.max(node.width, TEXT_CARD_WIDTH),
    height: Math.max(node.height, TEXT_CARD_HEIGHT),
  }
}

function overlaps(
  box: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    box.x < other.x + other.width &&
    box.x + box.width > other.x &&
    box.y < other.y + other.height &&
    box.y + box.height > other.y
  )
}

/**
 * 点节点一侧的加号：右边新建图片卡，当前节点成为它的上文；
 * 左边新建文本卡，接到当前节点前面。同一侧再点就往外排，不叠在上一张上。
 */
export function placeNodeBeside(
  editor: CanvasEditor,
  doc: Y.Doc,
  anchorId: string,
  side: 'left' | 'right',
  textFill: string,
): string | null {
  const snapshot = readCanvasDocument(doc)
  const anchor = snapshot.nodes.find((node) => node.id === anchorId)
  if (!anchor || anchor.type === 'timeline') return null
  const from = cardSize(anchor)
  const kind = side === 'right' ? 'image' : 'text'
  const next =
    kind === 'text'
      ? { width: TEXT_CARD_WIDTH, height: TEXT_CARD_HEIGHT }
      : { width: EMPTY_IMAGE_NODE, height: EMPTY_IMAGE_NODE }
  let x = side === 'right' ? anchor.x + from.width + SPAWN_GAP : anchor.x - SPAWN_GAP - next.width
  const y = anchor.y + (from.height - next.height) / 2
  const occupied = snapshot.nodes.map((node) => ({ x: node.x, y: node.y, ...cardSize(node) }))
  for (let step = 0; step < 12; step += 1) {
    const box = { x, y, width: next.width, height: next.height }
    if (!occupied.some((one) => overlaps(box, one))) break
    x += side === 'right' ? next.width + SPAWN_GAP : -(next.width + SPAWN_GAP)
  }
  const center = { x: x + next.width / 2, y: y + next.height / 2 }
  const id =
    kind === 'text' ? placeNodeText(editor, center, textFill) : placeEmptyImageNode(doc, center)
  const link =
    side === 'right' ? { source: anchorId, target: id } : { source: id, target: anchorId }
  connectCanvasNodes(doc, link, insertOrigin)
  return id
}

/** 把这句话写进这张文本卡。空字符串留着卡片，不改框的大小。 */
export function commitNodeText(editor: CanvasEditor, id: string, raw: string): void {
  const el = editor.doc.getElement(id)
  if (el?.type !== 'text') return
  const text = raw.replace(/\u00a0/g, ' ')
  const next = text.trim() ? text : ''
  editor.doc.setEditingText(null)
  if (next === el.text) return
  editor.doc.updateElements([{ id, patch: { text: next } }], { history: true })
}
