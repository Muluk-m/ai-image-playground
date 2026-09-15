import { describe, expect, it } from 'vitest'
import type { CanvasEl } from '../../../../features/canvas/lib/canvasDoc'
import { Box } from '../../../../features/canvas/lib/geometry'
import {
  cameraForCenter,
  computeMinimapProjection,
  isInsideBox,
  MINIMAP_HEIGHT,
  MINIMAP_PADDING,
  MINIMAP_WIDTH,
  minimapPointToPage,
  minimapRects,
  minimapSourceBox,
  projectBox,
  rectsBounds,
} from '../../../../features/canvas/lib/minimap'

const SIZE = { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }

function image(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  video?: { taskId: string; outputIndex: number },
): CanvasEl {
  return {
    id,
    type: 'image',
    x,
    y,
    width: w,
    height: h,
    rotation: 0,
    fileId: `f_${id}`,
    ...(video ? { video } : {}),
  }
}

describe('minimapRects', () => {
  it('每个元素一块，按类型给出可区分的画法', () => {
    const elements: CanvasEl[] = [
      image('a', 0, 0, 100, 50),
      image('v', 200, 0, 100, 50, { taskId: 't', outputIndex: 0 }),
      {
        id: 't1',
        type: 'text',
        x: 0,
        y: 200,
        text: 'hi',
        fontSize: 64,
        fill: '#fff',
        width: 80,
        height: 70,
      },
      { id: 'a1', type: 'arrow', points: [0, 0, 10, 10], stroke: '#ef4444', strokeWidth: 12 },
      {
        id: 'p1',
        type: 'placeholder',
        x: 400,
        y: 0,
        width: 100,
        height: 100,
        status: 'error',
        message: '',
        meta: { taskId: '', clientRequestId: '', source: 'user-byok', prompt: '' },
      },
    ]

    const rects = minimapRects(elements)

    expect(rects).toHaveLength(5)
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 50, style: 'fill' })
    // 视频封面与普通图片不同色
    expect(rects[1].color).not.toBe(rects[0].color)
    // 文字与图片不同色
    expect(rects[2].color).not.toBe(rects[0].color)
    // 标注用自己的笔色
    expect(rects[3].color).toBe('#ef4444')
    // 占位框画虚框，取状态色
    expect(rects[4]).toMatchObject({ style: 'dash', color: '#ef4444' })
  })
})

describe('minimapSourceBox', () => {
  it('视口在内容内时就是内容包围盒', () => {
    const content = new Box(0, 0, 1000, 800)
    const source = minimapSourceBox(content, new Box(100, 100, 400, 300))
    expect([source.x, source.y, source.w, source.h]).toEqual([0, 0, 1000, 800])
  })

  it('视口跑到内容外时并上视口，视口框不会滑出小地图', () => {
    const content = new Box(0, 0, 100, 100)
    const source = minimapSourceBox(content, new Box(500, 500, 200, 200))
    expect([source.x, source.y, source.maxX, source.maxY]).toEqual([0, 0, 700, 700])
  })

  it('画布为空时退化成视口本身', () => {
    const source = minimapSourceBox(null, new Box(10, 20, 30, 40))
    expect([source.x, source.y, source.w, source.h]).toEqual([10, 20, 30, 40])
  })
})

describe('rectsBounds', () => {
  it('空集返回 null', () => {
    expect(rectsBounds([])).toBeNull()
  })

  it('取所有块的公共包围盒', () => {
    const bounds = rectsBounds(
      minimapRects([image('a', -50, 0, 100, 50), image('b', 200, 80, 100, 50)]),
    )
    expect(bounds && [bounds.x, bounds.y, bounds.maxX, bounds.maxY]).toEqual([-50, 0, 300, 130])
  })
})

describe('computeMinimapProjection', () => {
  it('保持宽高比，内容居中并留出边距', () => {
    // 宽高比 2:1 的内容装进 160x110（内框 144x94）→ 受宽度限制，scale = 144/1000
    const proj = computeMinimapProjection(new Box(0, 0, 1000, 500), SIZE)
    expect(proj.scale).toBeCloseTo(144 / 1000, 10)

    const projected = projectBox(proj, { x: 0, y: 0, w: 1000, h: 500 })
    expect(projected.x).toBeCloseTo(MINIMAP_PADDING, 10)
    expect(projected.w).toBeCloseTo(144, 10)
    // 竖直方向居中：上下留白相等
    expect(projected.y).toBeCloseTo((MINIMAP_HEIGHT - projected.h) / 2, 10)
  })

  it('高瘦内容受高度限制', () => {
    const proj = computeMinimapProjection(new Box(0, 0, 100, 1000), SIZE)
    expect(proj.scale).toBeCloseTo(94 / 1000, 10)
  })

  it('画出来的块永远落在小地图内', () => {
    const source = new Box(-300, -200, 900, 400)
    const proj = computeMinimapProjection(source, SIZE)
    const projected = projectBox(proj, source)
    expect(projected.x).toBeGreaterThanOrEqual(0)
    expect(projected.y).toBeGreaterThanOrEqual(0)
    expect(projected.x + projected.w).toBeLessThanOrEqual(MINIMAP_WIDTH)
    expect(projected.y + projected.h).toBeLessThanOrEqual(MINIMAP_HEIGHT)
  })

  it('退化成一个点的包围盒不会把 scale 变成无穷', () => {
    const proj = computeMinimapProjection(new Box(50, 50, 0, 0), SIZE)
    expect(Number.isFinite(proj.scale)).toBe(true)
    expect(proj.scale).toBeGreaterThan(0)
  })
})

describe('minimapPointToPage', () => {
  it('是 projectBox 的逆变换', () => {
    const proj = computeMinimapProjection(new Box(-100, 40, 800, 600), SIZE)
    const projected = projectBox(proj, { x: 120, y: 260, w: 0, h: 0 })
    const page = minimapPointToPage(proj, projected.x, projected.y)
    expect(page.x).toBeCloseTo(120, 8)
    expect(page.y).toBeCloseTo(260, 8)
  })
})

describe('cameraForCenter', () => {
  it('让视口中心落在目标页面点上，缩放不变', () => {
    const viewport = { width: 800, height: 600 }
    const camera = cameraForCenter({ x: 1000, y: 500 }, viewport, 2)
    expect(camera).toEqual({ x: 1000 - 800 / 2 / 2, y: 500 - 600 / 2 / 2 })
    // 反算回中心
    expect(camera.x + viewport.width / 2 / 2).toBe(1000)
  })
})

describe('isInsideBox', () => {
  it('边界算在内，外侧算外', () => {
    const box = new Box(0, 0, 100, 50)
    expect(isInsideBox(box, { x: 0, y: 0 })).toBe(true)
    expect(isInsideBox(box, { x: 100, y: 50 })).toBe(true)
    expect(isInsideBox(box, { x: 101, y: 20 })).toBe(false)
    expect(isInsideBox(box, { x: 20, y: -1 })).toBe(false)
  })
})
