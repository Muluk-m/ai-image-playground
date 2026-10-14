import * as Y from 'yjs'
import type { CanvasNode, CanvasOrigin } from './canvas-document'

export interface CanvasGroup {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  members: string[]
}
const groupsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('groups')
const membershipsOf = (doc: Y.Doc) => doc.getMap<string>('groupMembers')
const nodesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('nodes')
export function readCanvasGroups(doc: Y.Doc): CanvasGroup[] {
  const members = new Map<string, string[]>()
  for (const [nodeId, groupId] of membershipsOf(doc)) {
    if (!nodesOf(doc).has(nodeId)) continue
    const list = members.get(groupId) ?? []
    list.push(nodeId)
    members.set(groupId, list)
  }
  return [...groupsOf(doc).values()].map(
    (group) =>
      ({
        ...group.toJSON(),
        members: (members.get(String(group.get('id'))) ?? []).sort(),
      }) as CanvasGroup,
  )
}
export function createCanvasGroup(
  doc: Y.Doc,
  id: string,
  ids: readonly string[],
  name: string,
  origin: CanvasOrigin,
  bounds?: Pick<CanvasGroup, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  const nodes = [...new Set(ids)].flatMap((id) => {
    const node = nodesOf(doc).get(id)
    return node ? [node.toJSON() as CanvasNode] : []
  })
  if ((!nodes.length && !bounds) || groupsOf(doc).has(id) || nodesOf(doc).has(id)) return false
  const x = Math.min(...nodes.map((node) => node.x)) - 32
  const y = Math.min(...nodes.map((node) => node.y)) - 64
  const width = Math.max(...nodes.map((node) => node.x + node.width)) - x + 32
  const height = Math.max(...nodes.map((node) => node.y + node.height)) - y + 32
  const box = bounds ?? { x, y, width, height }
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width < 0 ||
    box.height < 0
  )
    return false
  doc.transact(() => {
    const group = new Y.Map<unknown>()
    for (const [key, value] of Object.entries({
      id,
      name: name.slice(0, 500),
      ...box,
    }))
      group.set(key, value)
    groupsOf(doc).set(id, group)
    for (const node of nodes) membershipsOf(doc).set(node.id, id)
  }, origin)
  return true
}
export function renameCanvasGroup(
  doc: Y.Doc,
  id: string,
  name: string,
  origin: CanvasOrigin,
): void {
  doc.transact(() => groupsOf(doc).get(id)?.set('name', name.slice(0, 500)), origin)
}
/** Disband only the frame; member nodes and their links remain intact. */
export function ungroupCanvasNodes(doc: Y.Doc, ids: readonly string[], origin: CanvasOrigin): void {
  const gone = new Set(ids)
  doc.transact(() => {
    for (const id of gone) groupsOf(doc).delete(id)
    for (const [id, groupId] of membershipsOf(doc))
      if (gone.has(groupId)) membershipsOf(doc).delete(id)
  }, origin)
}
export function moveCanvasGroups(
  doc: Y.Doc,
  moves: readonly { id: string; x: number; y: number }[],
  origin: CanvasOrigin,
): void {
  const groups = new Map(readCanvasGroups(doc).map((group) => [group.id, group]))
  doc.transact(() => {
    for (const move of moves) {
      const group = groups.get(move.id),
        stored = groupsOf(doc).get(move.id)
      if (!group || !stored || !Number.isFinite(move.x) || !Number.isFinite(move.y)) continue
      const dx = move.x - group.x,
        dy = move.y - group.y
      stored.set('x', move.x)
      stored.set('y', move.y)
      for (const id of group.members) {
        const node = nodesOf(doc).get(id)
        if (!node) continue
        node.set('x', Number(node.get('x')) + dx)
        node.set('y', Number(node.get('y')) + dy)
      }
    }
  }, origin)
}
/** Membership changes only when a node finishes moving, never from viewport movement. */
export function reconcileCanvasGroupMembership(
  doc: Y.Doc,
  ids: readonly string[],
  origin: CanvasOrigin,
): void {
  const groups = readCanvasGroups(doc).sort(
    (a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id),
  )
  doc.transact(() => {
    for (const id of ids) {
      const node = nodesOf(doc).get(id)?.toJSON() as CanvasNode | undefined
      if (!node) continue
      const contains = (group: CanvasGroup) =>
        node.x >= group.x &&
        node.y >= group.y + 32 &&
        node.x + node.width <= group.x + group.width &&
        node.y + node.height <= group.y + group.height
      const current = groups.find((group) => group.id === membershipsOf(doc).get(id))
      const next = current && contains(current) ? current : groups.find(contains)
      if (next) membershipsOf(doc).set(id, next.id)
      else membershipsOf(doc).delete(id)
    }
  }, origin)
}
