import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  canvasProjectDocument,
  initializeCanvasConnectionRules,
  validateCloudCanvas,
} from '../canvas-cloud'
import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  disconnectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  updateCanvasNode,
} from '../canvas-document'
import { createCanvasGroup } from '../canvas-groups'
import { canvasSyncStep1, canvasSyncStep2, readCanvasSyncMessage } from '../canvas-sync'
import type { ProjectDocument } from '../project-protocol'

const origin = canvasOrigin('user', 'one')
const legacy: ProjectDocument = {
  version: 1,
  elements: [
    {
      id: 'text',
      type: 'text',
      text: '旧标题',
      x: 25,
      y: -50,
      width: 100,
      height: 60,
      fill: '#fff',
      fontSize: 16,
    },
  ],
}
describe('cloud canvas migration and protocol', () => {
  it('keeps legacy ids and geometry and allows disconnected offline edits to converge', () => {
    const server = new Y.Doc()
    importLegacyElements(server, legacy.elements, origin)
    const a = new Y.Doc()
    const b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(server))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(server))
    moveCanvasNodes(a, [{ id: 'text', x: 140, y: 70 }], origin)
    insertCanvasNode(
      b,
      { id: 'new', type: 'image', x: 400, y: 0, width: 200, height: 100, data: {} },
      origin,
    )
    connectCanvasNodes(b, { source: 'text', target: 'new' }, origin)
    for (const doc of [a, b]) {
      const request = readCanvasSyncMessage(canvasSyncStep1(server))
      const reply = readCanvasSyncMessage(canvasSyncStep2(doc, request.value))
      Y.applyUpdate(server, reply.value)
    }
    for (const doc of [a, b]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(server))
    expect(readCanvasDocument(a)).toEqual(readCanvasDocument(b))
    expect(canvasProjectDocument(server, legacy).elements[0]).toMatchObject({
      id: 'text',
      x: 140,
      y: 70,
      text: '旧标题',
    })
    validateCloudCanvas(server, legacy)
  })
  it('retains media ids, video playback reference and annotations through migration', () => {
    const document: ProjectDocument = {
      version: 1,
      elements: [
        {
          id: 'video',
          type: 'image',
          mediaId: '11111111-1111-4111-8111-111111111111',
          video: { taskId: 'video-task', outputIndex: 0 },
          x: 30,
          y: 40,
          width: 300,
          height: 200,
          rotation: 20,
        },
        { id: 'ink', type: 'freedraw', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
      ],
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, document.elements, origin)
    expect(canvasProjectDocument(doc, document)).toEqual(document)
    validateCloudCanvas(doc, document)
  })
  it('rejects local bitmap references, malformed roots and non-finite geometry', () => {
    const doc = new Y.Doc()
    importLegacyElements(doc, [], origin)
    insertCanvasNode(
      doc,
      { id: 'bad', type: 'image', x: 0, y: 0, width: 10, height: 10, data: { fileId: 'local' } },
      origin,
    )
    expect(() => validateCloudCanvas(doc, legacy)).toThrow()
    deleteCanvasNode(doc, 'bad', origin)
    doc.getMap('secrets').set('payload', true)
    expect(() => validateCloudCanvas(doc, legacy)).toThrow()
  })
  it('preserves interleaved node and annotation layers', () => {
    const document: ProjectDocument = {
      version: 1,
      elements: [
        { id: 'ink', type: 'freedraw', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
        ...legacy.elements,
        { id: 'arrow', type: 'arrow', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
      ],
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, document.elements, origin)
    expect(canvasProjectDocument(doc, document)).toEqual(document)
    validateCloudCanvas(doc, document)
  })
  it('rejects malformed empty-node data and annotations before clients see them', () => {
    for (const patch of [
      { type: 'text', data: { text: '', fontSize: 16, fill: '#fff', name: {} } },
      { type: 'video', data: {} },
      { type: 'image', data: { pending: { type: 'placeholder' } } },
      {
        type: 'image',
        data: { pending: { type: 'placeholder', status: 'loading', message: '', meta: null } },
      },
      {
        type: 'image',
        data: {
          pending: {
            type: 'placeholder',
            status: 'loading',
            message: '',
            meta: {},
            id: 'override',
          },
        },
      },
      { type: 'image', data: { pending: { type: 'generation' } } },
    ]) {
      const doc = new Y.Doc()
      importLegacyElements(doc, legacy.elements, origin)
      const node = doc.getMap<Y.Map<unknown>>('nodes').get('text')!
      for (const [key, value] of Object.entries(patch)) node.set(key, value)
      expect(() => validateCloudCanvas(doc, legacy)).toThrow()
      doc.destroy()
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, legacy.elements, origin)
    doc.getMap('annotations').set('fake', { ...legacy.elements[0], id: 'fake', z: 1 })
    expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_annotation')
    doc.destroy()
  })
  it('rejects malformed and trailing wire data', () => {
    expect(() => readCanvasSyncMessage(new Uint8Array([9]))).toThrow()
    const bytes = canvasSyncStep1(new Y.Doc())
    expect(() => readCanvasSyncMessage(new Uint8Array([...bytes, 0]))).toThrow()
  })
})

it('enforces registry connections on the server without breaking pre-registry archives', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  insertCanvasNode(
    doc,
    {
      id: 'video',
      type: 'image',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  doc.getMap('edges').set('video:text', { id: 'video:text', source: 'video', target: 'text' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_connection')
  initializeCanvasConnectionRules(doc)
  const legacyConnections = doc.getMap<string>('legacyConnections').toJSON()
  const undo = createCanvasUndoManager(doc, origin)
  moveCanvasNodes(doc, [{ id: 'text', x: 1000, y: 5 }], origin)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  disconnectCanvasNodes(doc, 'video:text', origin)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  undo.undo()
  expect(readCanvasDocument(doc).edges).toHaveLength(1)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  insertCanvasNode(
    doc,
    {
      id: 'new-text',
      type: 'text',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { text: '', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  doc
    .getMap('edges')
    .set('video:new-text', { id: 'video:new-text', source: 'video', target: 'new-text' })
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).toThrow(
    'invalid_canvas_connection',
  )
  doc
    .getMap('legacyConnections')
    .set('video:new-text', JSON.stringify(['video', 'new-text', 'video', 'text']))
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).toThrow(
    'invalid_canvas_connection_policy',
  )
  undo.destroy()
  doc.destroy()
})

it('rejects malformed group geometry and membership before broadcasting', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  createCanvasGroup(doc, 'scene', ['text'], '第一场', origin)
  expect(() => validateCloudCanvas(doc, legacy)).not.toThrow()
  doc.getMap<Y.Map<unknown>>('groups').get('scene')!.set('width', Number.NaN)
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_group')
  doc.getMap<Y.Map<unknown>>('groups').get('scene')!.set('width', 500)
  doc.getMap('groupMembers').set('text', { id: 'scene' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_group')
  doc.destroy()
})

it('accepts concurrent overflow without dropping slots and remains syncable after reconciliation', () => {
  const a = new Y.Doc(),
    b = new Y.Doc()
  insertCanvasNode(
    a,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: { clips: Array.from({ length: 63 }, (_, i) => ({ elementId: `old-${i}`, in: 0 })) },
    },
    origin,
  )
  for (const id of ['a', 'b'])
    insertCanvasNode(
      a,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        data: { meta: { nodeKind: 'video' } },
      },
      origin,
    )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  connectCanvasNodes(a, { source: 'a', target: 'timeline' }, origin)
  connectCanvasNodes(b, { source: 'b', target: 'timeline' }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const node = readCanvasDocument(a).nodes.find((n) => n.id === 'timeline')!
  if (node.type !== 'timeline') throw new Error('missing timeline')
  expect(node.data.clips).toHaveLength(65)
  validateCloudCanvas(a, legacy)
  updateCanvasNode(a, 'timeline', { data: { clips: node.data.clips.slice(1) } }, origin)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(readCanvasDocument(b).nodes.find((n) => n.id === 'timeline')?.data).toEqual({
    clips: node.data.clips.slice(1),
  })
  validateCloudCanvas(b, legacy)
})

it('rejects malformed timeline slot payloads even when their target is absent', () => {
  for (const [field, value] of [
    ['clip', { elementId: 'a', in: -1 }],
    ['order', NaN],
    ['deleted', 'yes'],
    ['secret', 'x'],
  ]) {
    const doc = new Y.Doc()
    doc.getMap('timelineSlots').set(JSON.stringify(['timeline', 'source', 'a', field]), value)
    expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_timeline')
  }
})
