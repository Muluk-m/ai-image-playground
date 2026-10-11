import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  CANVAS_NODE_TYPES,
  canvasOrigin,
  createCanvasUndoManager,
  exportLegacyElements,
  importLegacyElements,
  type LegacyCanvasElement,
  moveCanvasNodes,
  readCanvasDocument,
} from '../canvas-document'

const generation = {
  model: 'grok-imagine-video',
  duration: 6,
  resolution: '720p',
  aspectRatio: '16:9',
} as const

const legacy: LegacyCanvasElement[] = [
  {
    id: 'img',
    type: 'image',
    fileId: 'file_1',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    rotation: 15,
    name: '海边',
    naturalWidth: 1536,
    naturalHeight: 1024,
    createdAt: 1700000000000,
    groupId: 'task_1',
    meta: { prompt: '海浪' },
  },
  {
    id: 'clip',
    type: 'image',
    mediaId: 'media_1',
    x: 400,
    y: 20,
    width: 320,
    height: 180,
    rotation: 0,
    video: { taskId: 'task_v', outputIndex: 0, generation },
  },
  { id: 'arrow', type: 'arrow', points: [0, 0, 50, 50], stroke: '#ef4444', strokeWidth: 12 },
  {
    id: 'note',
    type: 'text',
    x: 0,
    y: 300,
    text: '第一幕',
    fontSize: 64,
    fill: '#ef4444',
    width: 200,
    height: 80,
  },
  { id: 'pen', type: 'freedraw', points: [1, 2, 3, 4, 5, 6], stroke: '#000', strokeWidth: 4 },
  {
    id: 'pending',
    type: 'placeholder',
    x: 800,
    y: 0,
    width: 256,
    height: 256,
    status: 'loading',
    message: '',
    meta: { taskId: 'task_p', clientRequestId: 'req', source: 'builtin-edge', prompt: '猫' },
  },
  {
    id: 'reserved',
    type: 'generation',
    generationId: 'gen_1',
    position: 0,
    x: 1100,
    y: 0,
    width: 256,
    height: 256,
    errorCode: 'upstream_error',
  },
  {
    id: 'reel',
    type: 'timeline',
    x: 0,
    y: 500,
    width: 640,
    height: 120,
    clips: [{ elementId: 'clip', in: 0, out: 4 }],
  },
]

function imported(elements = legacy): Y.Doc {
  const doc = new Y.Doc()
  importLegacyElements(doc, elements, canvasOrigin('user', 'me'))
  return doc
}

describe('legacy conversion', () => {
  it('turns pictures, clips, text and timelines into nodes and marks into annotations', () => {
    const { nodes, annotations } = readCanvasDocument(imported())
    expect(nodes.map((node) => [node.id, node.type])).toEqual([
      ['img', 'image'],
      ['clip', 'video'],
      ['note', 'text'],
      ['pending', 'image'],
      ['reserved', 'image'],
      ['reel', 'timeline'],
    ])
    expect(annotations.map((one) => [one.id, one.type])).toEqual([
      ['arrow', 'arrow'],
      ['pen', 'freedraw'],
    ])
    expect(nodes.every((node) => CANVAS_NODE_TYPES.includes(node.type))).toBe(true)
  })

  it('keeps geometry and stacking order', () => {
    const { nodes, annotations } = readCanvasDocument(imported())
    const image = nodes.find((node) => node.id === 'img')!
    expect([image.x, image.y, image.width, image.height]).toEqual([10, 20, 300, 200])
    const order = [...nodes, ...annotations].sort((a, b) => a.z - b.z).map((one) => one.id)
    expect(order).toEqual(legacy.map((one) => one.id))
  })

  it('round-trips every element unchanged', () => {
    expect(exportLegacyElements(imported())).toEqual(legacy)
  })

  it('does nothing to a document that already has content', () => {
    const doc = imported()
    importLegacyElements(doc, [legacy[3]!], canvasOrigin('user', 'me'))
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

describe('moving nodes', () => {
  it('updates positions and survives a sync to another replica', () => {
    const doc = imported()
    moveCanvasNodes(doc, [{ id: 'img', x: 99, y: 88 }], canvasOrigin('user', 'me'))
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    const moved = readCanvasDocument(replica).nodes.find((node) => node.id === 'img')!
    expect([moved.x, moved.y]).toEqual([99, 88])
  })

  it('ignores ids that are not nodes', () => {
    const doc = imported()
    moveCanvasNodes(doc, [{ id: 'arrow', x: 1, y: 1 }], canvasOrigin('user', 'me'))
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

describe('undo', () => {
  it('undoes only the changes made by its own origin', () => {
    const doc = imported()
    const me = canvasOrigin('user', 'me')
    const agent = canvasOrigin('agent', 'batch')
    const undo = createCanvasUndoManager(doc, me)
    moveCanvasNodes(doc, [{ id: 'img', x: 1, y: 1 }], me)
    undo.stopCapturing()
    moveCanvasNodes(doc, [{ id: 'note', x: 5, y: 5 }], agent)
    undo.undo()
    const { nodes } = readCanvasDocument(doc)
    expect(nodes.find((node) => node.id === 'img')).toMatchObject({ x: 10, y: 20 })
    expect(nodes.find((node) => node.id === 'note')).toMatchObject({ x: 5, y: 5 })
  })

  it('treats one call as one step and can redo it', () => {
    const doc = imported()
    const me = canvasOrigin('user', 'me')
    const undo = createCanvasUndoManager(doc, me)
    moveCanvasNodes(
      doc,
      [
        { id: 'img', x: 1, y: 1 },
        { id: 'note', x: 2, y: 2 },
      ],
      me,
    )
    undo.undo()
    expect(exportLegacyElements(doc)).toEqual(legacy)
    undo.redo()
    expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'note')).toMatchObject({
      x: 2,
      y: 2,
    })
  })

  it('does not undo the import itself', () => {
    const doc = new Y.Doc()
    const me = canvasOrigin('user', 'me')
    const undo = createCanvasUndoManager(doc, me)
    importLegacyElements(doc, legacy, canvasOrigin('system', 'import'))
    undo.undo()
    expect(exportLegacyElements(doc)).toEqual(legacy)
  })
})

it('returns the same origin object for the same actor', () => {
  expect(canvasOrigin('user', 'me')).toBe(canvasOrigin('user', 'me'))
  expect(canvasOrigin('user', 'me')).not.toBe(canvasOrigin('agent', 'me'))
})
