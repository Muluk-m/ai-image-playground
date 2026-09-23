import { describe, expect, it } from 'vitest'
import {
  canvasLimitsFor,
  DESKTOP_CANVAS_LIMITS,
  exceedsCanvasLimits,
  IOS_CANVAS_LIMITS,
} from '../../../../features/toolbox/lib/canvasLimits'

describe('canvasLimitsFor', () => {
  it('treats iPadOS desktop-mode UA as iOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    expect(canvasLimitsFor({ userAgent: ua, maxTouchPoints: 5 })).toBe(IOS_CANVAS_LIMITS)
    expect(canvasLimitsFor({ userAgent: ua, maxTouchPoints: 0 })).toBe(DESKTOP_CANVAS_LIMITS)
  })
})

describe('exceedsCanvasLimits', () => {
  it('rejects two 48MP photos side by side on iOS but not on desktop', () => {
    expect(exceedsCanvasLimits(16128, 6048, IOS_CANVAS_LIMITS)).toBe(true)
    expect(exceedsCanvasLimits(16128, 6048, DESKTOP_CANVAS_LIMITS)).toBe(false)
  })

  it('rejects a single side over 32767 even when the area is small', () => {
    expect(exceedsCanvasLimits(32768, 10, DESKTOP_CANVAS_LIMITS)).toBe(true)
  })
})
