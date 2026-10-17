import type { CanvasSnapshot } from '@image-playground/shared'
import { nodeCardSize } from './nodeCanvasPlace'

export type CanvasPlacement = { id: string; x: number; y: number }

/** Keep the visible cards close while leaving room for handles and connection lines. */
export const CANVAS_LAYOUT_GAP = 32

/** Groups move as one unit. Cyclic group dependencies share a column without overlapping. */
export function arrangeNodes(snapshot: CanvasSnapshot): CanvasPlacement[] {
  const groups = snapshot.groups ?? []
  const owner = new Map(groups.flatMap((g) => g.members.map((id) => [id, g.id] as const)))
  const groupBounds = new Map(groups.map((group) => [group.id, { ...group }]))
  for (const node of snapshot.nodes) {
    const groupId = owner.get(node.id)
    const bounds = groupId ? groupBounds.get(groupId) : undefined
    if (!bounds) continue
    const size = nodeCardSize(node)
    const right = Math.max(bounds.x + bounds.width, node.x + size.width)
    const bottom = Math.max(bounds.y + bounds.height, node.y + size.height)
    bounds.x = Math.min(bounds.x, node.x)
    bounds.y = Math.min(bounds.y, node.y)
    bounds.width = right - bounds.x
    bounds.height = bottom - bounds.y
  }
  const boxes = [
    ...groupBounds.values(),
    ...snapshot.nodes
      .filter((n) => !owner.has(n.id))
      .map((n) => ({
        ...n,
        ...nodeCardSize(n),
      })),
  ].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  if (!boxes.length) return []
  const ids = new Set(boxes.map((b) => b.id))
  const incoming = new Map(boxes.map((b) => [b.id, new Set<string>()]))
  const outgoing = new Map(boxes.map((b) => [b.id, new Set<string>()]))
  for (const edge of snapshot.edges) {
    const source = owner.get(edge.source) ?? edge.source
    const target = owner.get(edge.target) ?? edge.target
    if (source === target || !ids.has(source) || !ids.has(target)) continue
    incoming.get(target)!.add(source)
    outgoing.get(source)!.add(target)
  }
  const remaining = new Map([...incoming].map(([id, edges]) => [id, edges.size]))
  const rank = new Map(boxes.map((b) => [b.id, 0]))
  const ready = boxes.filter((b) => !remaining.get(b.id)).map((b) => b.id)
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!
    for (const target of outgoing.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1))
      remaining.set(target, remaining.get(target)! - 1)
      if (!remaining.get(target)) ready.push(target)
    }
  }
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const unseen = new Set(ids)
  const clusters: { positions: CanvasPlacement[]; width: number; height: number }[] = []
  for (const box of boxes) {
    if (!unseen.delete(box.id)) continue
    const members = [box.id]
    for (let i = 0; i < members.length; i++) {
      const id = members[i]!
      for (const adjacent of [...incoming.get(id)!, ...outgoing.get(id)!])
        if (unseen.delete(adjacent)) members.push(adjacent)
    }
    const columns = new Map<number, typeof boxes>()
    for (const id of members) {
      const column = rank.get(id)!
      columns.set(column, [...(columns.get(column) ?? []), byId.get(id)!])
    }
    const height = Math.max(
      ...[...columns.values()].map((column) =>
        column.reduce((sum, n) => sum + n.height + CANVAS_LAYOUT_GAP, -CANVAS_LAYOUT_GAP),
      ),
    )
    const positions: CanvasPlacement[] = []
    let x = 0
    for (const [, column] of [...columns].sort(([a], [b]) => a - b)) {
      const columnHeight = column.reduce(
        (sum, n) => sum + n.height + CANVAS_LAYOUT_GAP,
        -CANVAS_LAYOUT_GAP,
      )
      let y = (height - columnHeight) / 2
      for (const node of column) {
        positions.push({ id: node.id, x, y })
        y += node.height + CANVAS_LAYOUT_GAP
      }
      x += Math.max(...column.map((n) => n.width)) + CANVAS_LAYOUT_GAP
    }
    clusters.push({ positions, width: x - CANVAS_LAYOUT_GAP, height })
  }
  clusters.sort((a, b) => b.height - a.height)
  const rowWidth = Math.max(
    ...clusters.map((c) => c.width),
    Math.sqrt(
      clusters.reduce(
        (sum, c) => sum + (c.width + CANVAS_LAYOUT_GAP) * (c.height + CANVAS_LAYOUT_GAP),
        0,
      ) * 1.6,
    ),
  )
  const origin = { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) }
  const placed = new Map<string, CanvasPlacement>()
  let x = 0,
    y = 0,
    rowHeight = 0
  for (const cluster of clusters) {
    if (x && x + cluster.width > rowWidth) {
      y += rowHeight + CANVAS_LAYOUT_GAP
      x = 0
      rowHeight = 0
    }
    for (const position of cluster.positions)
      placed.set(position.id, {
        id: position.id,
        x: origin.x + x + position.x,
        y: origin.y + y + position.y,
      })
    x += cluster.width + CANVAS_LAYOUT_GAP
    rowHeight = Math.max(rowHeight, cluster.height)
  }
  // Layout positions refer to the hull; return authored group origins so member offsets survive.
  for (const group of groups) {
    const position = placed.get(group.id)
    const bounds = groupBounds.get(group.id)!
    if (!position) continue
    position.x += group.x - bounds.x
    position.y += group.y - bounds.y
  }
  for (const node of snapshot.nodes) {
    const group = groups.find((g) => g.id === owner.get(node.id))
    const position = group && placed.get(group.id)
    if (group && position)
      placed.set(node.id, {
        id: node.id,
        x: node.x + position.x - group.x,
        y: node.y + position.y - group.y,
      })
  }
  return [...placed.values()]
}

/** Media/job updates do not invalidate a layout preview; geometry and topology changes do. */
export function arrangementKey(snapshot: CanvasSnapshot): string {
  return JSON.stringify([
    snapshot.nodes.map((n) => [n.id, n.type, n.x, n.y, n.width, n.height]),
    snapshot.edges.map((e) => [e.id, e.source, e.target]),
    snapshot.groups?.map((g) => [g.id, g.x, g.y, g.width, g.height, g.members]),
  ])
}
