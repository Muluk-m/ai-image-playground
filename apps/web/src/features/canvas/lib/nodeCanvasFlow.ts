import type { CanvasEdge, CanvasNode } from '@image-playground/shared'

/** 一条直接连进来的上游。只看这一跳，不把更前面的节点也算进来。 */
export interface NodeReference {
  id: string
  kind: 'image' | 'text' | 'video'
  label: string
  text?: string
  fileId?: string
  asset?: boolean
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
      kind: node.type === 'video' || node.data.meta?.nodeKind === 'video' ? 'video' : 'image',
      label: node.data.name?.trim() ?? '',
      ...(node.data.meta?.nodeKind === 'asset'
        ? {
            asset: true,
            text: [node.data.name, node.data.meta.assetDescription].filter(Boolean).join('：'),
          }
        : {}),
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

/**
 * 悬停一条线时，点亮这条流程上的线：这条线本身、它前面连进来的，
 * 以及落到的节点后面继续出去的。旁边分出去的另一条流程不算。
 */
export function flowEdgeIds(
  edges: readonly { id: string; source: string; target: string }[],
  edgeId: string,
): string[] {
  const start = edges.find((edge) => edge.id === edgeId)
  if (!start) return []
  const outgoing = new Map<string, { id: string; target: string }[]>()
  const incoming = new Map<string, { id: string; source: string }[]>()
  for (const edge of edges) {
    const outs = outgoing.get(edge.source)
    if (outs) outs.push(edge)
    else outgoing.set(edge.source, [edge])
    const ins = incoming.get(edge.target)
    if (ins) ins.push(edge)
    else incoming.set(edge.target, [edge])
  }
  const lit = new Set<string>([start.id])
  const walk = (
    startNode: string,
    next: (nodeId: string) => readonly { id: string; toward: string }[],
  ) => {
    const pending = [startNode]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const nodeId = pending.pop()
      if (!nodeId || seen.has(nodeId)) continue
      seen.add(nodeId)
      for (const edge of next(nodeId)) {
        if (lit.has(edge.id)) continue
        lit.add(edge.id)
        pending.push(edge.toward)
      }
    }
  }
  walk(start.target, (nodeId) =>
    (outgoing.get(nodeId) ?? []).map((edge) => ({ id: edge.id, toward: edge.target })),
  )
  walk(start.source, (nodeId) =>
    (incoming.get(nodeId) ?? []).map((edge) => ({ id: edge.id, toward: edge.source })),
  )
  return [...lit]
}

/** 上游文字按连线顺序放在用户这句话前面。图片不进这句话，走参考图。 */
export function composeNodePrompt(
  userPrompt: string,
  references: readonly NodeReference[],
): string {
  const notes = references.flatMap((ref) =>
    (ref.kind === 'text' || ref.asset) && ref.text ? [ref.text] : [],
  )
  return [...notes, userPrompt.trim()].filter(Boolean).join('\n')
}

export function referenceFileIds(
  references: readonly NodeReference[],
  files: Readonly<Record<string, string>>,
): string[] {
  return [
    ...new Set(
      references.flatMap((ref) =>
        ref.kind === 'image' && ref.fileId && files[ref.fileId] ? [ref.fileId] : [],
      ),
    ),
  ]
}
