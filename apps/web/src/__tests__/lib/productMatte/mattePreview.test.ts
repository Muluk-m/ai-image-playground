import { describe, expect, it } from 'vitest'
import type { ProductAlpha } from '../../../lib/productMatte'
import { alphaToMattePreview, alphaToPreviewPixels } from '../../../lib/productMatte'

/** 左半边是产品，右半边是背景。 */
function halfMatte(): ProductAlpha {
  return { alpha: new Uint8ClampedArray([255, 0, 255, 0]), width: 2, height: 2 }
}

describe('alphaToPreviewPixels', () => {
  it('tints the product and leaves the rest see-through', () => {
    const preview = alphaToPreviewPixels(halfMatte())

    expect(preview.width).toBe(2)
    expect(preview.height).toBe(2)
    expect(preview.data[3]).toBeGreaterThan(0)
    expect(preview.data[3]).toBeLessThan(255)
    expect(preview.data[7]).toBe(0)
  })

  it('keeps a soft alpha out of the product: half matted is half tinted', () => {
    const soft = alphaToPreviewPixels({
      alpha: new Uint8ClampedArray([0, 128, 255, 255]),
      width: 2,
      height: 2,
    })

    expect(soft.data[3]).toBe(0)
    expect(soft.data[7]).toBeGreaterThan(0)
    expect(soft.data[7]).toBeLessThan(soft.data[11])
  })
})

describe('alphaToMattePreview', () => {
  it('encodes the overlay as a PNG data URL', () => {
    expect(alphaToMattePreview(halfMatte())).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  })
})
