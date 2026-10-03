import { describe, expect, it, vi } from 'vitest'
import type { ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import {
  maskStrokeRegion,
  pageToMaskPixel,
  paintMaskStroke,
} from '../../../../features/canvas/lib/inpaintMask'

/**
 * 涂抹点从页面坐标换到遮罩像素坐标这一步错了，界面上看不出来：紫色高亮照样画在手指下面，
 * 送上游的遮罩却圈在别处，于是「只改这一块」改的是另一块。旋转过的图最容易踩到符号写反。
 */
function image(overrides: Partial<ImageEl> = {}): ImageEl {
  return {
    id: 'img',
    type: 'image',
    x: 100,
    y: 50,
    width: 400,
    height: 300,
    rotation: 0,
    fileId: 'file',
    ...overrides,
  }
}

const SIZE = { width: 1024, height: 768 }

describe('pageToMaskPixel', () => {
  it('maps the element corners onto the mask corners', () => {
    const el = image()
    expect(pageToMaskPixel(el, SIZE, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 })
    expect(pageToMaskPixel(el, SIZE, { x: 500, y: 350 })).toEqual({ x: 1024, y: 768 })
  })

  it('scales display units up to bitmap pixels', () => {
    // 展示宽 400 对应位图宽 1024：页面上走 100 就是位图上走 256。
    expect(pageToMaskPixel(image(), SIZE, { x: 200, y: 50 })).toEqual({ x: 256, y: 0 })
  })

  it('undoes rotation about the element origin', () => {
    // Konva 绕左上角转；转 90° 后元素的「局部 +x」指向页面 +y。
    const el = image({ rotation: 90 })
    const atLocalX = { x: 100 - 0, y: 50 + 400 }
    const mapped = pageToMaskPixel(el, SIZE, atLocalX)
    expect(mapped.x).toBeCloseTo(1024, 6)
    expect(mapped.y).toBeCloseTo(0, 6)
  })

  it('keeps an off-axis point consistent with the forward transform', () => {
    const el = image({ rotation: 37 })
    const rad = (37 * Math.PI) / 180
    // 正变换：局部 (dx, dy) → 页面。取一个内部点，换回去必须还是它。
    const dx = 123
    const dy = 87
    const page = {
      x: el.x + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: el.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    }
    const mapped = pageToMaskPixel(el, SIZE, page)
    expect(mapped.x).toBeCloseTo((dx / el.width) * SIZE.width, 6)
    expect(mapped.y).toBeCloseTo((dy / el.height) * SIZE.height, 6)
  })
})

describe('rectangle edit mask', () => {
  it('uses the same rotated image coordinates for preview and submitted mask', () => {
    const el = image({ rotation: 90 })
    const fillRect = vi.fn()
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect,
    } as unknown as CanvasRenderingContext2D
    const region = {
      tool: 'brush' as const,
      shape: 'rect' as const,
      width: 0,
      points: [
        { x: 60, y: 150 },
        { x: -40, y: 250 },
      ],
    }

    paintMaskStroke(ctx, el, SIZE, region, { inverted: true, color: '#159cf6' })
    const [x, y, width, height] = fillRect.mock.calls[0]!
    expect(x).toBeCloseTo(256)
    expect(y).toBeCloseTo(102.4)
    expect(width).toBeCloseTo(256)
    expect(height).toBeCloseTo(256)
    expect(ctx.globalCompositeOperation).toBe('source-over')

    paintMaskStroke(ctx, el, SIZE, region, { inverted: false, color: '#fff' })
    expect(fillRect).toHaveBeenCalledTimes(2)
    expect(ctx.globalCompositeOperation).toBe('destination-out')
  })
})

it('uses stable numbers and rotated normalized bounds for numbered region evidence', () => {
  const result = maskStrokeRegion(
    image({ rotation: 90 }),
    {
      tool: 'brush',
      shape: 'rect',
      width: 0,
      points: [
        { x: 70, y: 90 },
        { x: -20, y: 250 },
      ],
    },
    7,
  )
  expect(result.number).toBe(7)
  expect(result.x).toBeCloseTo(0.1)
  expect(result.y).toBeCloseTo(0.1)
  expect(result.width).toBeCloseTo(0.4)
  expect(result.height).toBeCloseTo(0.3)
})
