import {
  type CanvasSnapshot,
  canvasConnectionAllowed,
  canvasKindsConnect,
  canvasNodeKind,
  connectCanvasNodes,
  type ImageNodeData,
  PROJECT_TIMELINE_MAX_CLIPS,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { accountScope } from '../../../lib/authScope'
import { getImageDimensions } from '../../../lib/canvasImage'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import type { CanvasEditor } from './editor'
import { fileToDataUrl } from './importImages'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export type ReferenceSlot = 'first' | 'last'
export class CanvasReferenceLimitError extends Error {}

function linkedImageIds(snapshot: CanvasSnapshot, targetId: string): Set<string> {
  const connected = new Set(
    snapshot.edges.filter((edge) => edge.target === targetId).map((edge) => edge.source),
  )
  return new Set(
    snapshot.nodes.flatMap((node) =>
      connected.has(node.id) &&
      canvasNodeKind(node) === 'image' &&
      node.type === 'image' &&
      node.data.fileId
        ? [node.data.fileId]
        : [],
    ),
  )
}
export function canvasReferenceCandidates(
  snapshot: CanvasSnapshot,
  targetId: string,
  slot?: ReferenceSlot,
): Set<string> {
  const target = snapshot.nodes.find((node) => node.id === targetId)
  if (!target) return new Set()
  const connected = new Set(
    snapshot.edges.filter((edge) => edge.target === targetId).map((edge) => edge.source),
  )
  const imageIds = linkedImageIds(snapshot, targetId)
  return new Set(
    snapshot.nodes
      .filter((source) => {
        if (!canvasConnectionAllowed(source, target)) return false
        const kind = canvasNodeKind(source)
        if (target.type === 'timeline')
          return (
            kind === 'video' &&
            !slot &&
            !target.data.clips.some((clip) => clip.elementId === source.id) &&
            target.data.clips.length < PROJECT_TIMELINE_MAX_CLIPS
          )
        if (kind === 'video' || kind === 'timeline') return false
        if (
          slot &&
          (kind !== 'image' || source.type !== 'image' || source.data.meta?.nodeKind === 'asset')
        )
          return false
        if (source.type === 'text' && !source.data.text.trim()) return false
        if (
          source.type === 'image' &&
          !source.data.fileId &&
          !(
            source.data.meta?.nodeKind === 'asset' &&
            (source.data.meta.assetDescription?.trim() || source.data.name?.trim())
          )
        )
          return false
        if (connected.has(source.id)) return Boolean(slot)
        return (
          source.type !== 'image' ||
          !source.data.fileId ||
          imageIds.has(source.data.fileId) ||
          imageIds.size < API_MAX_IMAGES
        )
      })
      .map((source) => source.id),
  )
}
export function canPickCanvasReference(
  snapshot: CanvasSnapshot,
  targetId: string,
  sourceId: string,
  slot?: ReferenceSlot,
): boolean {
  return canvasReferenceCandidates(snapshot, targetId, slot).has(sourceId)
}

export function addCanvasReference(
  canvas: NodeCanvasDocument,
  targetId: string,
  sourceId: string,
  slot?: ReferenceSlot,
): boolean {
  if (!canPickCanvasReference(readCanvasDocument(canvas.doc), targetId, sourceId, slot))
    return false
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    connectCanvasNodes(canvas.doc, { source: sourceId, target: targetId }, canvas.origin)
    const data = canvas.doc.getMap<Y.Map<unknown>>('nodes').get(targetId)?.get('data') as
      | ImageNodeData
      | undefined
    if (slot && data)
      updateCanvasNode(
        canvas.doc,
        targetId,
        {
          data: {
            ...data,
            meta: {
              ...data.meta,
              [slot === 'first' ? 'videoFirstFrame' : 'videoLastFrame']: sourceId,
            },
          },
        },
        canvas.origin,
      )
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return true
}

/** Decode before inserting so failed uploads never leave an empty reference or replace a card. */
export async function uploadCanvasReference(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  targetId: string,
  file: File,
  slot?: ReferenceSlot,
): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null
  const account = accountScope()
  const targetMap = canvas.doc.getMap('nodes').get(targetId)
  if (!targetMap) return null
  const source = await fileToDataUrl(file)
  const dimensions = await getImageDimensions(source)
  if (
    !account() ||
    canvas.doc.isDestroyed ||
    canvas.doc.getMap('nodes').get(targetId) !== targetMap
  )
    return null
  const snapshot = readCanvasDocument(canvas.doc)
  const target = snapshot.nodes.find((n) => n.id === targetId)
  if (!target || !canvasKindsConnect('image', canvasNodeKind(target))) return null
  if (linkedImageIds(snapshot, targetId).size >= API_MAX_IMAGES)
    throw new CanvasReferenceLimitError()
  const fileId = editor.doc.cacheBitmap(source)
  let id = ''
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    const width = 320,
      height = Math.max(120, (width * dimensions.height) / dimensions.width)
    id = createNode(canvas, 'image', { x: target.x, y: target.y }, '', {
      nodes: [target],
      side: 'left',
      size: { width, height },
    })
    updateCanvasNode(
      canvas.doc,
      id,
      {
        data: {
          fileId,
          name: file.name,
          naturalWidth: dimensions.width,
          naturalHeight: dimensions.height,
        },
      },
      canvas.origin,
    )
    addCanvasReference(canvas, targetId, id, slot)
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return id
}
