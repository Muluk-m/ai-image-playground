import { describe, expect, it } from 'vitest'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { Box } from '../../../../features/canvas/lib/geometry'
import {
  computePlaceholderTarget,
  computePlaceholderTargets,
  findFreeTarget,
  fitToTarget,
  PLACEMENT_GAP,
} from '../../../../features/canvas/lib/placement'

/** placement 是纯函数，只读 editor 的视口与元素包围盒。 */
function makeEditor(
  viewport: { midX: number; midY: number; w?: number },
  occupied: Box[] = [],
): CanvasEditor {
  return {
    getViewportPageBounds: () => ({ w: 4000, ...viewport }),
    getOccupiedBounds: () => [...occupied],
  } as unknown as CanvasEditor
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

describe('findFreeTarget', () => {
  const start = { x: 0, y: 0, w: 100, h: 100 }
  const row = { x: 0, width: 400 }

  const cases: { name: string; obstacles: Box[]; expected: { x: number; y: number } }[] = [
    { name: '没人挡就留在原位', obstacles: [], expected: { x: 0, y: 0 } },
    {
      name: '被挡就跳到挡路者右边界加一个间距',
      obstacles: [new Box(-10, -10, 60, 200)],
      expected: { x: 50 + PLACEMENT_GAP, y: 0 },
    },
    {
      name: '连着两个挡路者就一路往右让',
      obstacles: [new Box(0, 0, 50, 100), new Box(50 + PLACEMENT_GAP, 0, 50, 100)],
      expected: { x: 100 + 2 * PLACEMENT_GAP, y: 0 },
    },
    {
      name: '这一行放不下就回到行首、往下挪一行',
      obstacles: [new Box(0, 0, 380, 100)],
      expected: { x: 0, y: 100 + PLACEMENT_GAP },
    },
    {
      name: '挨着边不算相交，贴边的空位照用',
      obstacles: [new Box(-100, 0, 100, 100)],
      expected: { x: 0, y: 0 },
    },
  ]

  for (const { name, obstacles, expected } of cases) {
    it(name, () => {
      expect(findFreeTarget(start, obstacles, row)).toEqual({ ...start, ...expected })
    })
  }

  it('行列都走完时落到所有元素下方，保证返回的位置是空的', () => {
    // 一整片密不透风的障碍：每一行每一列都被占满。
    const wall = Array.from({ length: 200 }, (_, i) => new Box(-5000, i * 10, 10_000, 10))

    const target = findFreeTarget(start, wall, row)

    expect(wall.some((one) => one.collides(new Box(target.x, target.y, target.w, target.h)))).toBe(
      false,
    )
  })
})

describe('computePlaceholderTargets', () => {
  it('画布空着时 n 个目标沿水平方向等距排开', () => {
    const editor = makeEditor({ midX: 180, midY: 180 })

    const targets = computePlaceholderTargets(editor, null, 3)

    expect(targets).toHaveLength(3)
    expect(targets[1].x).toBe(targets[0].x + targets[0].w + PLACEMENT_GAP)
    expect(targets[2].x).toBe(targets[0].x + 2 * (targets[0].w + PLACEMENT_GAP))
    expect(targets.map((one) => one.y)).toEqual([targets[0].y, targets[0].y, targets[0].y])
  })

  it('理想位置被已有元素占住时让开，不压住它', () => {
    const blocker = new Box(0, 0, 360, 360)
    const editor = makeEditor({ midX: 180, midY: 180 }, [blocker])

    const [target] = computePlaceholderTargets(editor, null, 1)

    expect(new Box(target.x, target.y, target.w, target.h).collides(blocker)).toBe(false)
  })

  it('多个目标彼此不重叠', () => {
    const editor = makeEditor({ midX: 180, midY: 180 }, [new Box(0, 0, 500, 100)])

    const targets = computePlaceholderTargets(editor, null, 4)

    const boxes = targets.map((one) => new Box(one.x, one.y, one.w, one.h))
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(boxes[i].collides(boxes[j])).toBe(false)
      }
    }
  })

  it('count<=0 也至少给一个目标', () => {
    const editor = makeEditor({ midX: 180, midY: 180 })

    expect(computePlaceholderTargets(editor, null, 0)).toHaveLength(1)
  })
})

describe('fitToTarget', () => {
  const frame = { w: 360, h: 360 }

  it('大图缩小到框内，保持宽高比', () => {
    // 2048×1024 横图：宽贴满 360，高按比例
    expect(fitToTarget(2048, 1024, frame)).toEqual({ w: 360, h: 180 })
    // 1024×2048 竖图：高贴满 360，宽按比例
    expect(fitToTarget(1024, 2048, frame)).toEqual({ w: 180, h: 360 })
  })

  it('小图放大到框内（展示尺寸与展位框一致）', () => {
    expect(fitToTarget(90, 90, frame)).toEqual({ w: 360, h: 360 })
  })

  it('非正方形框也按短边贴合', () => {
    expect(fitToTarget(1000, 1000, { w: 400, h: 200 })).toEqual({ w: 200, h: 200 })
  })
})
