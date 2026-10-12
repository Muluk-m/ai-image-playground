import * as Y from 'yjs'
import { type CanvasNode, readCanvasDocument } from './canvas-document'
import { CANVAS_STATE_MAX_BYTES } from './canvas-sync'
import { isProjectDocument, type ProjectDocument, type ProjectElement } from './project-protocol'

/** Read model for old consumers (Agent archive and project listing). Y.Doc is authoritative. */
export function canvasProjectDocument(doc: Y.Doc, identity: ProjectDocument): ProjectDocument {
  const { nodes, annotations } = readCanvasDocument(doc)
  const elements: ProjectElement[] = []
  for (const node of [...nodes].sort((a, b) => a.z - b.z)) {
    const { id, x, y, width, height, type, data } = node
    const box = { id, x, y, width, height }
    if (type === 'text') {
      const { text, fontSize, fill } = data as Extract<CanvasNode, { type: 'text' }>['data']
      elements.push({ ...box, type, text, fontSize, fill })
    } else if (type === 'timeline') {
      elements.push({
        ...box,
        type,
        clips: (data as Extract<CanvasNode, { type: 'timeline' }>['data']).clips,
      })
    } else if ('mediaId' in data && data.mediaId) {
      const { fileId: _fileId, pending: _pending, ...image } = data
      elements.push({
        ...image,
        ...box,
        type: 'image',
        mediaId: data.mediaId,
        rotation: data.rotation ?? 0,
      })
    } else if ('pending' in data && data.pending?.type === 'generation') {
      elements.push({ ...box, ...data.pending })
    }
  }
  for (const { z: _z, ...annotation } of annotations) elements.push(annotation as ProjectElement)
  return { ...identity, elements }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000
const allowed = (value: object, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key))

/** Validate the complete candidate before accepting any update; never apply untrusted bytes to a live room. */
export function validateCloudCanvas(doc: Y.Doc, identity: ProjectDocument): void {
  const roots = ['nodes', 'edges', 'annotations', 'meta', 'managedNodes', 'deletedNodes']
  if ([...doc.share.keys()].some((key) => !roots.includes(key)))
    throw new Error('invalid_canvas_document')
  // An update missing its causal predecessor cannot be validated yet. Clients resend a full diff on reconnect.
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('incomplete_canvas_update')
  if (Y.encodeStateAsUpdate(doc).length > CANVAS_STATE_MAX_BYTES)
    throw new Error('canvas_document_too_large')
  for (const [key, value] of doc.getMap('nodes'))
    if (!(value instanceof Y.Map) || value.get('id') !== key) throw new Error('invalid_canvas_node')
  for (const root of ['annotations', 'edges'])
    for (const [key, value] of doc.getMap(root))
      if (!object(value) || value.id !== key) throw new Error('invalid_canvas_document')
  const { nodes, edges, annotations } = readCanvasDocument(doc)
  if (nodes.length + annotations.length > 1000 || edges.length > 4000)
    throw new Error('canvas_document_too_large')
  for (const node of nodes) {
    if (
      !object(node) ||
      !id(node.id) ||
      !allowed(node, ['id', 'type', 'x', 'y', 'width', 'height', 'z', 'data']) ||
      !['x', 'y', 'width', 'height', 'z'].every((key) => finite(node[key as keyof CanvasNode])) ||
      node.width < 0 ||
      node.height < 0 ||
      !object(node.data) ||
      !['text', 'image', 'video', 'timeline'].includes(node.type)
    )
      throw new Error('invalid_canvas_node')
    const data = node.data
    if (node.type === 'image' || node.type === 'video') {
      if (
        !allowed(data, [
          'fileId',
          'mediaId',
          'rotation',
          'name',
          'naturalWidth',
          'naturalHeight',
          'createdAt',
          'groupId',
          'meta',
          'pending',
          'video',
        ])
      )
        throw new Error('invalid_canvas_node')
      if (
        'fileId' in data &&
        data.fileId !== undefined &&
        (!('mediaId' in data) || data.fileId !== `cloud-${data.mediaId}`)
      )
        throw new Error('canvas_media_not_ready')
      // Validate empty nodes with the same persisted media schema as completed ones.
      const { fileId: _file, pending: _pending, ...image } = data
      if (
        !isProjectDocument({
          version: 1,
          elements: [
            {
              ...image,
              id: node.id,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              type: 'image',
              rotation: data.rotation ?? 0,
              mediaId: data.mediaId ?? '00000000-0000-0000-0000-000000000000',
            },
          ],
        })
      )
        throw new Error('invalid_canvas_node')
      if (
        data.pending &&
        (!object(data.pending) ||
          typeof data.pending.type !== 'string' ||
          !['placeholder', 'generation'].includes(data.pending.type))
      )
        throw new Error('invalid_canvas_pending')
    } else if (
      !allowed(data, node.type === 'text' ? ['text', 'fontSize', 'fill', 'name'] : ['clips'])
    )
      throw new Error('invalid_canvas_node')
    if (JSON.stringify(data).length > 100_000 || JSON.stringify(data).includes('data:image/'))
      throw new Error('invalid_canvas_node')
  }
  // Deletion and concurrent edge insertion may leave dangling edges; they are inert, not corrupt data.
  for (const edge of edges)
    if (
      !object(edge) ||
      !allowed(edge, ['id', 'source', 'target']) ||
      !id(edge.source) ||
      !id(edge.target) ||
      edge.source === edge.target ||
      edge.id !== `${edge.source}:${edge.target}`
    )
      throw new Error('invalid_canvas_edge')
  for (const key of ['deletedNodes', 'managedNodes']) {
    for (const [name, value] of doc.getMap(key))
      if (!id(name) || value !== true) throw new Error('invalid_canvas_document')
  }
  if ([...doc.getMap('meta')].some(([key, value]) => key !== 'legacyImported' || value !== true))
    throw new Error('invalid_canvas_document')
  if (
    new TextEncoder().encode(JSON.stringify(doc.toJSON())).length > 512 * 1024 ||
    !isProjectDocument(canvasProjectDocument(doc, identity))
  )
    throw new Error('invalid_canvas_document')
}
