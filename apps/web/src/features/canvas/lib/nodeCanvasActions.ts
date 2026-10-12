import {
  type CanvasNode,
  type CanvasSnapshot,
  connectCanvasNodes,
  deleteCanvasNode,
  disconnectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import { newElementId } from './canvasDoc'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export type CreateNodeKind = 'text' | 'image' | 'video'
export function nodeKind(node: CanvasNode): CreateNodeKind | 'timeline' {
  return node.type === 'image' && node.data.meta?.nodeKind === 'video' ? 'video' : node.type
}
export function createNode(
  canvas: NodeCanvasDocument,
  kind: CreateNodeKind,
  point: { x: number; y: number },
  fill: string,
  beside?: { nodes: readonly CanvasNode[]; side: 'left' | 'right' },
): string {
  const id = newElementId()
  const width = kind === 'text' ? 300 : 360
  const height = kind === 'text' ? 220 : 240
  const occupied = readCanvasDocument(canvas.doc).nodes
  const anchors = beside?.nodes ?? []
  const gap = 96
  const x = anchors.length
    ? beside?.side === 'left'
      ? Math.min(...anchors.map((n) => n.x)) - gap - width
      : Math.max(...anchors.map((n) => n.x + n.width)) + gap
    : point.x - width / 2
  const preferredY = anchors.length ? Math.min(...anchors.map((n) => n.y)) : point.y - height / 2
  const column = occupied.filter((n) => x < n.x + n.width + gap && x + width + gap > n.x)
  // Keep siblings in one column, choosing the nearest free slot above or below the anchor.
  const candidates = [
    preferredY,
    ...column.flatMap((n) => [n.y + n.height + gap, n.y - height - gap]),
  ].sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY) || b - a)
  const y =
    candidates.find((candidate) =>
      column.every((n) => candidate >= n.y + n.height + gap || candidate + height + gap <= n.y),
    ) ?? preferredY
  canvas.undo.stopCapturing()
  insertCanvasNode(
    canvas.doc,
    {
      id,
      type: kind === 'text' ? 'text' : 'image',
      x,
      y,
      width,
      height,
      data: kind === 'text' ? { text: '', fontSize: 16, fill } : { meta: { nodeKind: kind } },
    },
    canvas.origin,
  )
  return id
}
export function changeNodeText(canvas: NodeCanvasDocument, id: string, text: string): void {
  const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)
  if (node?.type !== 'text' || node.data.text === text) return
  canvas.undo.stopCapturing()
  updateCanvasNode(canvas.doc, id, { data: { ...node.data, text } }, canvas.origin)
}
export function removeNodes(
  canvas: NodeCanvasDocument,
  ids: readonly string[],
  edgeIds: readonly string[] = [],
): void {
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const id of ids) deleteCanvasNode(canvas.doc, id, canvas.origin)
    for (const id of edgeIds) disconnectCanvasNodes(canvas.doc, id, canvas.origin)
  }, canvas.origin)
}
export function copyNodes(snapshot: CanvasSnapshot, ids: readonly string[]): CanvasSnapshot {
  const selected = new Set(ids)
  return structuredClone({
    nodes: snapshot.nodes.filter((n) => selected.has(n.id)),
    annotations: [],
    edges: snapshot.edges.filter((e) => selected.has(e.source) && selected.has(e.target)),
  })
}
export function pasteNodes(
  canvas: NodeCanvasDocument,
  copied: CanvasSnapshot,
  point: { x: number; y: number },
): string[] {
  if (!copied.nodes.length) return []
  const x = Math.min(...copied.nodes.map((n) => n.x))
  const y = Math.min(...copied.nodes.map((n) => n.y))
  const ids = new Map(copied.nodes.map((n) => [n.id, newElementId()]))
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const node of copied.nodes) {
      const data = structuredClone(node.data)
      if ('pending' in data) delete data.pending
      if ('meta' in data && data.meta) {
        const meta = { ...data.meta }
        for (const key of Object.keys(meta)) {
          if (!key.startsWith('role:')) continue
          const target = ids.get(key.slice(5))
          if (target) meta[`role:${target}`] = meta[key]!
          delete meta[key]
        }
        if (meta.referenceOrder) {
          try {
            const order = JSON.parse(meta.referenceOrder)
            meta.referenceOrder = JSON.stringify(
              Array.isArray(order) ? order.flatMap((id) => ids.get(id) ?? []) : [],
            )
          } catch {
            delete meta.referenceOrder
          }
        }
        data.meta = meta
      }
      insertCanvasNode(
        canvas.doc,
        { ...node, id: ids.get(node.id)!, x: node.x - x + point.x, y: node.y - y + point.y, data },
        canvas.origin,
      )
    }
    for (const edge of copied.edges)
      connectCanvasNodes(
        canvas.doc,
        { source: ids.get(edge.source)!, target: ids.get(edge.target)! },
        canvas.origin,
      )
  }, canvas.origin)
  return [...ids.values()]
}
