import {
  type CanvasNode,
  type CanvasSnapshot,
  canvasNodeKind,
  canvasNodeRegistry,
  connectCanvasNodes,
  createCanvasGroup,
  deleteCanvasNode,
  disconnectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
  ungroupCanvasNodes,
  updateCanvasNode,
} from '@image-playground/shared'
import { newElementId } from './canvasDoc'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export type CreateNodeKind = 'text' | 'image' | 'video' | 'timeline' | 'storyboard'
export function nodeKind(node: CanvasNode): CreateNodeKind | 'timeline' {
  return canvasNodeKind(node)
}
export function createNode(
  canvas: NodeCanvasDocument,
  kind: CreateNodeKind,
  point: { x: number; y: number },
  fill: string,
  beside?: {
    nodes: readonly CanvasNode[]
    side: 'left' | 'right'
    size?: { width: number; height: number }
  },
): string {
  const id = newElementId()
  const { width, height } = beside?.size ?? canvasNodeRegistry[kind].size
  const occupied = readCanvasDocument(canvas.doc).nodes
  const anchors = beside?.nodes ?? []
  const gap = 168
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
      type:
        kind === 'storyboard'
          ? 'storyboard'
          : kind === 'timeline'
            ? 'timeline'
            : kind === 'text'
              ? 'text'
              : 'image',
      x,
      y,
      width,
      height,
      data:
        kind === 'storyboard'
          ? { shots: [] }
          : kind === 'timeline'
            ? { clips: [] }
            : kind === 'text'
              ? { text: '', fontSize: 16, fill }
              : { meta: { nodeKind: kind } },
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
    ungroupCanvasNodes(canvas.doc, ids, canvas.origin)
    for (const id of ids) deleteCanvasNode(canvas.doc, id, canvas.origin)
    for (const id of edgeIds) disconnectCanvasNodes(canvas.doc, id, canvas.origin)
  }, canvas.origin)
}
export function copyNodes(snapshot: CanvasSnapshot, ids: readonly string[]): CanvasSnapshot {
  const selected = new Set(ids)
  const groups = snapshot.groups?.filter((group) => selected.has(group.id)) ?? []
  for (const group of groups) for (const id of group.members) selected.add(id)
  return structuredClone({
    ...(groups.length ? { groups } : {}),
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
  const boxes = copied.nodes.length ? copied.nodes : (copied.groups ?? [])
  if (!boxes.length) return []
  const x = Math.min(...boxes.map((n) => n.x))
  const y = Math.min(...boxes.map((n) => n.y))
  const groupIds: string[] = []
  const ids = new Map(copied.nodes.map((n) => [n.id, newElementId()]))
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const node of copied.nodes) {
      const data = structuredClone(node.data)
      if ('clips' in data)
        data.clips = data.clips.map((clip) => ({
          ...clip,
          elementId: ids.get(clip.elementId) ?? clip.elementId,
        }))
      if ('shots' in data) {
        data.shots = data.shots.map((shot) => ({
          ...shot,
          lookIds: shot.lookIds.map((id) => ids.get(id) ?? id),
          ...(shot.locationId ? { locationId: ids.get(shot.locationId) ?? shot.locationId } : {}),
        }))
        delete data.confirmed
      }
      if ('pending' in data) delete data.pending
      if ('meta' in data && data.meta) {
        const meta = { ...data.meta }
        for (const key of ['frameOf', 'videoFirstFrame', 'videoLastFrame']) {
          if (meta[key] && ids.has(meta[key])) meta[key] = ids.get(meta[key])!
        }
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
        // Copied output is independent until a copied storyboard is reviewed again.
        if (meta.storyboardId) {
          const boardId = ids.get(meta.storyboardId)
          if (boardId && meta.storyboardRole !== 'grid') {
            meta.storyboardId = boardId
            delete meta.storyboardFingerprint
            if (meta.storyboardSources) {
              try {
                meta.storyboardSources = JSON.stringify(
                  JSON.parse(meta.storyboardSources).flatMap((id: string) => ids.get(id) ?? []),
                )
              } catch {
                delete meta.storyboardSources
              }
            }
          } else {
            for (const key of Object.keys(meta)) if (key.startsWith('storyboard')) delete meta[key]
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
    // A timeline copied alone still references its original shots; rebuild those visible links.
    for (const node of copied.nodes) {
      if (node.type === 'storyboard') {
        for (const source of new Set(
          node.data.shots.flatMap((shot) => [
            ...shot.lookIds,
            ...(shot.locationId ? [shot.locationId] : []),
          ]),
        ))
          connectCanvasNodes(
            canvas.doc,
            { source: ids.get(source) ?? source, target: ids.get(node.id)! },
            canvas.origin,
          )
      }
      if (node.type !== 'timeline') continue
      for (const clip of node.data.clips)
        connectCanvasNodes(
          canvas.doc,
          { source: ids.get(clip.elementId) ?? clip.elementId, target: ids.get(node.id)! },
          canvas.origin,
        )
    }
    for (const group of copied.groups ?? []) {
      const id = newElementId()
      if (
        createCanvasGroup(
          canvas.doc,
          id,
          group.members.flatMap((id) => ids.get(id) ?? []),
          group.name,
          canvas.origin,
          {
            x: group.x - x + point.x,
            y: group.y - y + point.y,
            width: group.width,
            height: group.height,
          },
        )
      )
        groupIds.push(id)
    }
    for (const edge of copied.edges)
      connectCanvasNodes(
        canvas.doc,
        { source: ids.get(edge.source)!, target: ids.get(edge.target)! },
        canvas.origin,
      )
  }, canvas.origin)
  return [...groupIds, ...ids.values()]
}
