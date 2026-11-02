import {
  connectCanvasNodes,
  type ImagePreset,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

/** Selecting a preset prepares an editable branch; generation only starts on Send. */
export function createImagePresetNode(
  canvas: NodeCanvasDocument,
  sourceId: string,
  preset: ImagePreset,
): string | undefined {
  const source = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === sourceId)
  if (source?.type !== 'image' || !source.data.fileId) return undefined
  let id: string | undefined
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    id = createNode(canvas, 'image', source, '', { nodes: [source], side: 'right' })
    updateCanvasNode(
      canvas.doc,
      id,
      { data: { meta: { nodeKind: 'image', nodeImagePreset: preset.skillName } } },
      canvas.origin,
    )
    connectCanvasNodes(canvas.doc, { source: sourceId, target: id }, canvas.origin)
  }, canvas.origin)
  return id
}
