// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  type LegacyCanvasElement,
  moveCanvasNodes,
  readCanvasDocument,
} from '@image-playground/shared'
import { expect, it } from 'vitest'
import { openNodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'

const legacy: LegacyCanvasElement[] = [
  {
    id: 'img',
    type: 'image',
    fileId: 'file_1',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    rotation: 0,
  },
  { id: 'arrow', type: 'arrow', points: [0, 0, 50, 50], stroke: '#ef4444', strokeWidth: 12 },
]

it('converts the legacy scene once and keeps later edits across reopen', async () => {
  const first = await openNodeCanvasDocument('scene-a', () => legacy)
  expect(readCanvasDocument(first.doc).nodes.map((node) => node.id)).toEqual(['img'])
  moveCanvasNodes(first.doc, [{ id: 'img', x: 99, y: 88 }], first.origin)
  first.destroy()
  // y-indexeddb 写盘是异步的，给它一拍。
  await new Promise((resolve) => setTimeout(resolve, 50))

  const second = await openNodeCanvasDocument('scene-a', () => legacy)
  const node = readCanvasDocument(second.doc).nodes[0]!
  expect([node.x, node.y]).toEqual([99, 88])
  expect(readCanvasDocument(second.doc).annotations.map((one) => one.id)).toEqual(['arrow'])
  second.destroy()
})

it('keeps projects apart', async () => {
  const one = await openNodeCanvasDocument('scene-b', () => legacy)
  const other = await openNodeCanvasDocument('scene-c', () => [])
  expect(readCanvasDocument(other.doc).nodes).toEqual([])
  one.destroy()
  other.destroy()
})

it('undoes the device user moves but not the conversion', async () => {
  const canvas = await openNodeCanvasDocument('scene-d', () => legacy)
  moveCanvasNodes(canvas.doc, [{ id: 'img', x: 1, y: 1 }], canvas.origin)
  canvas.undo.undo()
  canvas.undo.undo()
  const node = readCanvasDocument(canvas.doc).nodes[0]!
  expect([node.x, node.y]).toEqual([10, 20])
  canvas.destroy()
})
