import { describe, expect, it } from 'vitest'
import type { CanvasEl } from '../../../../features/canvas/lib/canvasDoc'
import { Box } from '../../../../features/canvas/lib/geometry'
import { buildSnapTargets, resolveSnap } from '../../../../features/canvas/lib/snapping'

function imageEl(id: string, x: number, y: number, width = 100, height = 80): CanvasEl {
  return { id, type: 'image', x, y, width, height, rotation: 0, fileId: `f-${id}` }
}

describe('buildSnapTargets', () => {
  it('collects left/center/right and top/center/bottom edges, excluding the dragged selection', () => {
    const targets = buildSnapTargets([imageEl('a', 0, 0), imageEl('b', 200, 0)], new Set(['b']))
    expect(targets.xs.map((e) => e.value)).toEqual([0, 50, 100])
    expect(targets.ys.map((e) => e.value)).toEqual([0, 40, 80])
  })
})

describe('resolveSnap', () => {
  const targets = buildSnapTargets([imageEl('a', 0, 0)], new Set())

  it('snaps a nearby edge onto the target edge and emits a guide', () => {
    // 拖到 x=104：左边缘距目标右边缘（100）4，阈值内 → 吸附 -4
    const { adjustX, adjustY, guides } = resolveSnap(targets, new Box(104, 300, 50, 50), 8)
    expect(adjustX).toBe(-4)
    expect(adjustY).toBe(0)
    expect(guides).toEqual([{ axis: 'x', value: 100, from: 0, to: 350 }])
  })

  it('snaps both axes independently', () => {
    // 中心 x 贴目标中心 50，顶边贴目标底边 80
    const { adjustX, adjustY, guides } = resolveSnap(targets, new Box(28, 83, 50, 50), 8)
    expect(adjustX).toBe(-3) // midX 53 → 50
    expect(adjustY).toBe(-3) // y 83 → 80
    expect(guides).toHaveLength(2)
  })

  it('does nothing beyond the threshold', () => {
    const { adjustX, adjustY, guides } = resolveSnap(targets, new Box(120, 300, 50, 50), 8)
    expect(adjustX).toBe(0)
    expect(adjustY).toBe(0)
    expect(guides).toEqual([])
  })

  it('prefers the closest edge when several are in range', () => {
    // 左边缘 99：距右边缘（100）1、距中心（50）远 → 吸最近的 100
    const { adjustX } = resolveSnap(targets, new Box(99, 300, 50, 50), 8)
    expect(adjustX).toBe(1)
  })
})
