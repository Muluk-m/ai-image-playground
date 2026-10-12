import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { canvasProjectDocument, validateCloudCanvas } from '../canvas-cloud'
import {
  canvasOrigin,
  connectCanvasNodes,
  deleteCanvasNode,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
} from '../canvas-document'
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
