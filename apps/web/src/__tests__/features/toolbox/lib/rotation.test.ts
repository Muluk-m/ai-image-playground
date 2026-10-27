import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROTATION,
  normalizeAngle,
  rotationSize,
} from '../../../../features/toolbox/lib/rotation'

describe('rotation output bounds', () => {
  it.each([
    [0, 1400, 1460],
    [90, 1460, 1400],
    [180, 1400, 1460],
    [270, 1460, 1400],
    [-90, 1460, 1400],
  ])('keeps original pixels at %s degrees', (angle, width, height) => {
    expect(rotationSize(1400, 1460, { ...DEFAULT_ROTATION, angle })).toEqual({ width, height })
  })

  it('expands arbitrary angles to keep every corner, without rescaling the image', () => {
    expect(rotationSize(400, 300, { ...DEFAULT_ROTATION, angle: 45 })).toEqual({
      width: 495,
      height: 495,
    })
    expect(rotationSize(400, 300, { ...DEFAULT_ROTATION, angle: -15.7 })).toEqual({
      width: 467,
      height: 398,
    })
  })

  it('keeps the original frame when expansion is turned off', () => {
    expect(rotationSize(400, 300, { ...DEFAULT_ROTATION, angle: 45, expand: false })).toEqual({
      width: 400,
      height: 300,
    })
  })

  it('mirroring does not change output dimensions', () => {
    const settings = { ...DEFAULT_ROTATION, angle: 32.1 }
    expect(rotationSize(400, 300, { ...settings, flipH: true, flipV: true })).toEqual(
      rotationSize(400, 300, settings),
    )
  })
})

describe('angle controls', () => {
  it('wraps repeated turns and keeps fine adjustments at one decimal place', () => {
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(-270)).toBe(90)
    expect(normalizeAngle(179.9 + 0.1 + 0.1)).toBe(-179.9)
    expect(normalizeAngle(0.1 + 0.2)).toBe(0.3)
  })
})
