import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  canvasOrigin,
  connectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
} from '../canvas-document'
import { canvasConnectionAllowed, canvasNodeKind, canvasNodeRegistry } from '../canvas-registry'

it('uses semantic video kinds and rejects unsupported links independent of canvas position', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  insertCanvasNode(
    doc,
    {
      id: 'text',
      type: 'text',
      x: 800,
      y: 0,
      width: 300,
      height: 220,
      data: { text: '', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  insertCanvasNode(
    doc,
    {
      id: 'video',
      type: 'image',
      x: 0,
      y: 0,
      width: 360,
      height: 240,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  const [text, video] = readCanvasDocument(doc).nodes
  expect(canvasNodeKind(video!)).toBe('video')
  expect(canvasConnectionAllowed(text!, video!)).toBe(true)
  expect(connectCanvasNodes(doc, { source: 'text', target: 'video' }, origin)).toBe(true)
  expect(canvasConnectionAllowed(video!, text!)).toBe(false)
  expect(connectCanvasNodes(doc, { source: 'video', target: 'text' }, origin)).toBe(false)
  expect(canvasNodeRegistry.text.description.length).toBeGreaterThan(0)
  doc.destroy()
})
