import type { ProductBox } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  MATTE_BOX_IOU_THRESHOLD,
  matteAgreesWithBox,
  matteBounds,
} from '../../../lib/productMatte'
import type { ProductAlpha } from '../../../lib/productMatte'

/** 在 10×10 的画布上把一个矩形涂成产品，坐标是像素格。 */
function matteWithRect(x: number, y: number, w: number, h: number): ProductAlpha {
  const width = 10
  const height = 10
  const alpha = new Uint8ClampedArray(width * height)
  for (let row = y; row < y + h; row++) {
    for (let column = x; column < x + w; column++) alpha[row * width + column] = 255
  }
  return { alpha, width, height }
}

const HALF: ProductBox = { x: 0, y: 0, w: 0.5, h: 0.5 }

describe('matteBounds', () => {
  it('reads the bounding box of the product pixels, normalised', () => {
    expect(matteBounds(matteWithRect(2, 4, 3, 2))).toEqual({ x: 0.2, y: 0.4, w: 0.3, h: 0.2 })
  })

  it('has no box when nothing was matted', () => {
    expect(matteBounds(matteWithRect(0, 0, 0, 0))).toBeNull()
  })
})

describe('matteAgreesWithBox', () => {
  it('agrees when the matte lands on the box the plan reported', () => {
    expect(matteAgreesWithBox(matteWithRect(0, 0, 5, 5), HALF)).toBe(true)
  })

  /** 试点里显著性模型抠中了说明气泡而不是浴缸，两个框几乎不重叠。 */
  it('calls the matte suspect when it sits somewhere else entirely', () => {
    expect(matteAgreesWithBox(matteWithRect(6, 6, 4, 4), HALF)).toBe(false)
  })

  it('calls a matte suspect when it swallows far more than the product', () => {
    expect(matteAgreesWithBox(matteWithRect(0, 0, 10, 10), HALF)).toBe(false)
  })

  it('takes a lower threshold when one is given', () => {
    // 交 0.25、并 0.6，重叠率 0.42：默认阈值判可疑，放宽到 0.4 就放行。
    const partialOverlap = matteWithRect(0, 0, 6, 10)

    expect(matteAgreesWithBox(partialOverlap, HALF)).toBe(false)
    expect(matteAgreesWithBox(partialOverlap, HALF, 0.4)).toBe(true)
  })

  it('has nothing to disagree with when the plan reported no product box', () => {
    expect(matteAgreesWithBox(matteWithRect(6, 6, 4, 4), null)).toBe(true)
  })

  it('rejects an empty matte outright', () => {
    expect(matteAgreesWithBox(matteWithRect(0, 0, 0, 0), HALF)).toBe(false)
  })

  it('defaults to half the union', () => {
    expect(MATTE_BOX_IOU_THRESHOLD).toBe(0.5)
  })
})
