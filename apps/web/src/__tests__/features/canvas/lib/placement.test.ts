import type { Box, Editor } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
  computePlaceholderTarget,
  fanOutTargets,
  PLACEMENT_GAP,
} from '../../../../features/canvas/lib/placement'

/** placement 是纯函数，只读 editor.getViewportPageBounds / bounds 的几个字段。 */
function makeEditor(viewport: { midX: number; midY: number }): Editor {
  return { getViewportPageBounds: () => viewport } as unknown as Editor
}

function makeBounds(b: { maxX: number; midX: number; midY: number }): Box {
  return b as unknown as Box
}

describe('computePlaceholderTarget', () => {
  it('有选区：落在选区右侧、垂直居中于包围盒', () => {
    const editor = makeEditor({ midX: 9999, midY: 9999 })
    const bounds = makeBounds({ maxX: 200, midX: 100, midY: 150 })

    const target = computePlaceholderTarget(editor, bounds)

    // 右侧：x = 包围盒右边界 + 间距
    expect(target.x).toBe(200 + PLACEMENT_GAP)
    // 垂直居中：占位框中心对齐 bounds.midY
    expect(target.y + target.h / 2).toBe(150)
    expect(target.w).toBeGreaterThan(0)
    expect(target.h).toBeGreaterThan(0)
  })

  it('无选区（文生图）：落在视口中心', () => {
    const editor = makeEditor({ midX: 500, midY: 400 })

    const target = computePlaceholderTarget(editor, null)

    expect(target.x + target.w / 2).toBe(500)
    expect(target.y + target.h / 2).toBe(400)
  })
})

describe('fanOutTargets', () => {
  const base = { x: 100, y: 50, w: 360, h: 360 }

  it('n 个目标沿水平方向排开，彼此留间距', () => {
    const targets = fanOutTargets(base, 3)

    expect(targets).toHaveLength(3)
    expect(targets[0]).toEqual(base)
    expect(targets[1].x).toBe(100 + 360 + PLACEMENT_GAP)
    expect(targets[2].x).toBe(100 + 2 * (360 + PLACEMENT_GAP))
    // y/w/h 不变
    for (const t of targets) {
      expect(t.y).toBe(50)
      expect(t.w).toBe(360)
      expect(t.h).toBe(360)
    }
  })

  it('n<=1 时只有 base 一个目标', () => {
    expect(fanOutTargets(base, 1)).toEqual([base])
    expect(fanOutTargets(base, 0)).toEqual([base])
  })
})
