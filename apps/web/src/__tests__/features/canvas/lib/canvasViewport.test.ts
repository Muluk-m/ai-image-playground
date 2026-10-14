import { describe, expect, it } from 'vitest'
import {
  type CanvasViewportBox,
  type CanvasViewportLink,
  planCanvasViewport,
} from '../../../../features/canvas/lib/canvasViewport'

const COLS = 60
const ROWS = 50
const NODE_COUNT = COLS * ROWS

/** 60×50 网格，步长 400×300，每张卡 200×160。编号按行优先。 */
function grid(): CanvasViewportBox[] {
  const items: CanvasViewportBox[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const index = row * COLS + col
      items.push({
        id: `n${index}`,
        x: col * 400,
        y: row * 300,
        width: 200,
        height: 160,
      })
    }
  }
  return items
}

/** 4000 条连续边：n[i] → n[i+1]，超出节点数后绕回。 */
function chain(): CanvasViewportLink[] {
  return Array.from({ length: 4000 }, (_, index) => ({
    id: `e${index}`,
    source: `n${index % NODE_COUNT}`,
    target: `n${(index + 1) % NODE_COUNT}`,
  }))
}

const items = grid()
const edges = chain()

describe('planCanvasViewport', () => {
  it('mounts the padded 1280×800 view and drops to an overview when the whole grid is in frame', () => {
    const started = performance.now()
    const near = planCanvasViewport({
      items,
      edges,
      frame: { x: 0, y: 0, zoom: 1, width: 1280, height: 800 },
    })
    const far = planCanvasViewport({
      items,
      edges,
      frame: { x: 0, y: 0, zoom: 0.05, width: 1280, height: 800 },
    })
    const elapsed = performance.now() - started

    expect(near.mode).toBe('detail')
    expect(near.mountedIds).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n60',
      'n61',
      'n62',
      'n63',
      'n120',
      'n121',
      'n122',
      'n123',
      'n180',
      'n181',
      'n182',
      'n183',
    ])
    expect(near.visibleEdgeIds).toEqual([
      'e0',
      'e1',
      'e2',
      'e60',
      'e61',
      'e62',
      'e120',
      'e121',
      'e122',
      'e180',
      'e181',
      'e182',
      'e3000',
      'e3001',
      'e3002',
      'e3060',
      'e3061',
      'e3062',
      'e3120',
      'e3121',
      'e3122',
      'e3180',
      'e3181',
      'e3182',
    ])
    expect(far.mode).toBe('overview')
    expect(far.mountedIds).toEqual([])
    expect(far.painted.map((box) => box.id)).toHaveLength(NODE_COUNT)
    expect(far.visibleEdgeIds).toHaveLength(4000)
    expect(elapsed).toBeLessThan(100)
  })

  it('uses a title card below half scale, and an overview before the viewport is measured', () => {
    const few = items.slice(0, 4)
    const frame = { x: 0, y: 0, zoom: 0.4, width: 1280, height: 800 }
    const card = planCanvasViewport({ items: few, edges: [], frame })
    const detail = planCanvasViewport({
      items: few,
      edges: [],
      frame: { ...frame, zoom: 0.5 },
    })
    const unmeasured = planCanvasViewport({
      items,
      edges,
      frame: { x: 0, y: 0, zoom: 1, width: 0, height: 0 },
    })
    const pinned = planCanvasViewport({
      items,
      edges,
      frame: { x: 0, y: 0, zoom: 0.05, width: 1280, height: 800 },
      pinnedIds: ['missing', ...Array.from({ length: 90 }, (_, index) => `n${index}`), 'n0'],
    })
    const covered = planCanvasViewport({
      items: [
        { id: 'group', x: -10_000, y: -10_000, width: 50_000, height: 50_000 },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `far${index}`,
          x: 100_000,
          y: index * 300,
          width: 200,
          height: 160,
        })),
      ],
      edges: [],
      frame: { x: 0, y: 0, zoom: 1, width: 1280, height: 800 },
    })
    const focused = planCanvasViewport({
      items,
      edges: [],
      frame: { x: 0, y: 0, zoom: 1, width: 1280, height: 800 },
      pinnedIds: ['n500'],
    })

    expect(card.mode).toBe('card')
    expect(card.mountedIds).toEqual(['n0', 'n1', 'n2', 'n3'])
    expect(detail.mode).toBe('detail')
    expect(detail.mountedIds).toEqual(['n0', 'n1', 'n2', 'n3'])
    expect(unmeasured.mode).toBe('overview')
    expect(unmeasured.mountedIds).toEqual([])
    expect(unmeasured.painted).toEqual([])
    expect(pinned.mode).toBe('overview')
    expect(pinned.mountedIds).toEqual(Array.from({ length: 80 }, (_, index) => `n${index}`))
    expect(covered.mode).toBe('detail')
    expect(covered.mountedIds).toEqual(['group'])
    expect(focused.mode).toBe('detail')
    expect(focused.mountedIds).not.toContain('n500')
  })
})
