import type { CanvasNode, CanvasSnapshot } from '@image-playground/shared'
import { expect, it } from 'vitest'
import { arrangeNodes } from '../../../../features/canvas/lib/arrangeNodes'
import { nodeCardSize } from '../../../../features/canvas/lib/nodeCanvasPlace'

const node = (id: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: 'image',
  z: 0,
  x,
  y,
  width: 280,
  height: 280,
  data: {},
})
it('lays out dependencies left to right and branches without overlapping; preview leaves the source untouched', () => {
  const snapshot: CanvasSnapshot = {
    nodes: [node('c', -300), node('a', 700), node('b', 700)],
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ac', source: 'a', target: 'c' },
    ],
    annotations: [],
  }
  const before = structuredClone(snapshot)
  const positions = new Map(arrangeNodes(snapshot).map((p) => [p.id, p]))
  expect(positions.get('b')!.x).toBeGreaterThan(positions.get('a')!.x + 280)
  expect(positions.get('b')!.x).toBe(positions.get('c')!.x)
  expect(Math.abs(positions.get('b')!.y - positions.get('c')!.y)).toBeGreaterThan(280)
  expect(snapshot).toEqual(before)
  expect(arrangeNodes(snapshot)).toEqual([...positions.values()])
})
it('preserves group member offsets and packs disconnected cards into a compact grid', () => {
  const snapshot: CanvasSnapshot = {
    nodes: [node('a', 110, 220), node('b', 410, 220), node('c')],
    groups: [
      { id: 'g', name: 'Group', x: 100, y: 200, width: 610, height: 320, members: ['a', 'b'] },
    ],
    edges: [],
    annotations: [],
  }
  const positions = new Map(arrangeNodes(snapshot).map((p) => [p.id, p]))
  expect(positions.get('a')!.x - positions.get('g')!.x).toBe(10)
  expect(positions.get('a')!.y - positions.get('g')!.y).toBe(20)
  expect(positions.get('b')!.x - positions.get('a')!.x).toBe(300)
  const c = positions.get('c')!,
    g = positions.get('g')!
  expect(c.x >= g.x + 610 || c.y >= g.y + 320 || c.x + 280 <= g.x || c.y + 280 <= g.y).toBe(true)
  expect(arrangeNodes({ nodes: [], edges: [], annotations: [] })).toEqual([])
})

it.each([
  { linked: true, memberX: 10, memberY: 20 },
  { linked: false, memberX: -300, memberY: -100 },
])('packs a small restored group by its visible media hull (linked=$linked)', ({ linked, memberX, memberY }) => {
  const snapshot: CanvasSnapshot = {
    nodes: [
      { ...node('member', 100 + memberX, 200 + memberY), width: 32, height: 24 },
      node('other', 500, 200),
    ],
    groups: [
      { id: 'group', name: 'Legacy', x: 100, y: 200, width: 48, height: 48, members: ['member'] },
    ],
    edges: linked ? [{ id: 'next', source: 'member', target: 'other' }] : [],
    annotations: [],
  }
  const before = structuredClone(snapshot)
  const positions = new Map(arrangeNodes(snapshot).map((position) => [position.id, position]))
  const member = { ...positions.get('member')!, ...nodeCardSize(snapshot.nodes[0]!) }
  const other = { ...positions.get('other')!, ...nodeCardSize(snapshot.nodes[1]!) }
  expect(
    member.x + member.width + 168 <= other.x ||
      other.x + other.width + 168 <= member.x ||
      member.y + member.height + 168 <= other.y ||
      other.y + other.height + 168 <= member.y,
  ).toBe(true)
  expect(member.x - positions.get('group')!.x).toBe(memberX)
  expect(member.y - positions.get('group')!.y).toBe(memberY)
  expect(snapshot).toEqual(before)
})
