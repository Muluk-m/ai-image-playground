import type * as Y from 'yjs'
import { readCanvasDocument } from './canvas-document'
import { canvasFingerprint } from './canvas-fingerprint'
import { canvasMainResult } from './canvas-result-store'
import { storyboardFingerprint } from './canvas-storyboard'

export * from './canvas-result-store'

/** Stable across layout, thumbnails, labels, and local/cloud cache identifiers. */
export function canvasInputFingerprint(doc: Y.Doc, nodeId: string): string {
  const snapshot = readCanvasDocument(doc)
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const inputs = snapshot.edges
    .filter((edge) => edge.target === nodeId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((edge) => {
      const node = nodes.get(edge.source)
      if (!node) return [edge.source, null]
      if (node.type === 'text') return [node.id, 'text', node.data.text]
      if (node.type === 'timeline') return [node.id, 'timeline', node.data.clips]
      if (node.type === 'storyboard') return [node.id, 'storyboard', node.data.shots]
      const result = canvasMainResult(doc, node.id)
      return [
        node.id,
        node.type,
        result?.id ??
          node.data.meta?.contentIdentity ??
          node.data.mediaId ??
          node.data.fileId ??
          null,
        node.type === 'video' ? [node.data.video.taskId, node.data.video.outputIndex] : null,
        node.data.meta?.videoTrimIn ?? null,
        node.data.meta?.videoTrimOut ?? null,
        ...(node.data.meta?.nodeKind === 'asset'
          ? [[node.data.name ?? '', node.data.meta.assetDescription ?? '']]
          : []),
      ]
    })
  const target = nodes.get(nodeId)
  const meta = target && 'meta' in target.data ? target.data.meta : undefined
  if (meta?.nodeImagePreset)
    inputs.push(['image-preset', meta.nodeImagePreset, meta.nodePrompt ?? ''])
  // Storyboard outputs also belong to the reviewed shot revision, not just its asset inputs.
  if (meta?.storyboardId && meta.storyboardRole) {
    inputs.push([
      'storyboard',
      meta.storyboardFingerprint ?? null,
      meta.nodePrompt ?? '',
      meta.storyboardGrid ?? null,
      meta.storyboardFrameIds ?? null,
      meta.storyboardFrameInputs ?? null,
    ])
    const board = nodes.get(meta.storyboardId)
    if (board?.type === 'storyboard') {
      const current = storyboardFingerprint(board.data.shots)
      if (current !== meta.storyboardFingerprint) inputs.push(['storyboard-edited', current])
    }
  }
  return canvasFingerprint(JSON.stringify(inputs))
}

export function canvasResultIsStale(doc: Y.Doc, nodeId: string): boolean {
  const previous = canvasMainResult(doc, nodeId)?.inputFingerprint
  return previous !== undefined && previous !== canvasInputFingerprint(doc, nodeId)
}
