import { describe, expect, it } from 'vitest'
import { applyHandleDrag, MIN_RECT_SIDE } from '../../../../features/canvas/lib/imageRectEdit'

/**
 * 夹取写错了界面上看不出来：框照样跟着手指走，只有到了提交那一步才发现裁切裁到了图外、
 * 或者「扩图」其实把画面缩小了。两个方向是相反的约束，所以各自钉死。
 */
const ELEMENT = { width: 400, height: 300 }
const FULL = { x: 0, y: 0, w: 400, h: 300 }

describe('applyHandleDrag', () => {
  it('keeps a crop inside the image however far the pointer goes', () => {
    const out = applyHandleDrag('crop', FULL, 'nw', { x: -500, y: -500 }, ELEMENT)
    expect(out).toEqual(FULL)
  })

  it('never lets a crop collapse below the minimum side', () => {
    const out = applyHandleDrag('crop', FULL, 'se', { x: -1000, y: -1000 }, ELEMENT)
    expect(out.w).toBe(MIN_RECT_SIDE)
    expect(out.h).toBe(MIN_RECT_SIDE)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
  })

  it('moves only the dragged edges', () => {
    const out = applyHandleDrag('crop', FULL, 'e', { x: -120, y: -80 }, ELEMENT)
    // 东手柄只动右边：上下与左边一律不跟着走。
    expect(out).toEqual({ x: 0, y: 0, w: 280, h: 300 })
  })

  it('keeps an outpaint frame from shrinking into the image', () => {
    const out = applyHandleDrag('outpaint', FULL, 'se', { x: -200, y: -200 }, ELEMENT)
    expect(out).toEqual(FULL)
  })

  it('lets an outpaint frame grow past the image on the dragged edge', () => {
    const out = applyHandleDrag('outpaint', FULL, 'w', { x: -150, y: 0 }, ELEMENT)
    expect(out).toEqual({ x: -150, y: 0, w: 550, h: 300 })
  })
})
