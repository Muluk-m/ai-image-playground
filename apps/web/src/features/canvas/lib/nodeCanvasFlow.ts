import type { CanvasEdge, CanvasNode } from '@image-playground/shared'

/** 一条直接连进来的上游。只看这一跳，不把更前面的节点也算进来。 */
export interface NodeReference {
  id: string
  kind: 'image' | 'text' | 'video'
  label: string
  text?: string
  fileId?: string
}

/** 目标节点的直接上游，按连线写入顺序。 */
export function incomingReferences(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  targetId: string,
): NodeReference[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const refs: NodeReference[] = []
  for (const edge of edges) {
    if (edge.target !== targetId) continue
    const node = byId.get(edge.source)
    if (!node || node.type === 'timeline') continue
    if (node.type === 'text') {
      const text = node.data.text.trim()
      refs.push({ id: node.id, kind: 'text', label: text.slice(0, 42), text })
      continue
    }
    refs.push({
      id: node.id,
      kind: node.type,
      label: node.data.name?.trim() ?? '',
      ...(node.data.fileId ? { fileId: node.data.fileId } : {}),
    })
  }
  return refs
}

/**
 * 从一侧加号拖出去，落在另一张卡上。从右边拖出，当前节点是上文；
 * 从左边拖出，落点那张卡是上文。落到自己身上不算一条线。
 */
export function linkFromDrag(
  from: { nodeId: string; handleType: 'source' | 'target' | null },
  toId: string | null,
): { source: string; target: string } | null {
  if (!from.nodeId || !toId || toId === from.nodeId) return null
  if (from.handleType === 'target') return { source: toId, target: from.nodeId }
  return { source: from.nodeId, target: toId }
}

/** 上游文字按连线顺序放在用户这句话前面。图片不进这句话，走参考图。 */
export function composeNodePrompt(
  userPrompt: string,
  references: readonly NodeReference[],
): string {
  const notes = references.flatMap((ref) => (ref.kind === 'text' && ref.text ? [ref.text] : []))
  return [...notes, userPrompt.trim()].filter(Boolean).join('\n')
}

export function referenceFileIds(references: readonly NodeReference[]): string[] {
  return references.flatMap((ref) => (ref.fileId ? [ref.fileId] : []))
}
