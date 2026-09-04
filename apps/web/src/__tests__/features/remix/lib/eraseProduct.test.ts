import { describe, expect, it } from 'vitest'
import { productBoxToPixelRect } from '../../../../features/remix/lib/eraseProduct'

describe('turning the normalised product box into a pixel rectangle', () => {
  it('scales the box to the image and rounds to whole pixels', () => {
    expect(
      productBoxToPixelRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, { width: 1000, height: 800 }),
    ).toEqual({ x: 250, y: 400, width: 500, height: 200 })
  })

  it('pads the box so the product edge is covered too', () => {
    expect(
      productBoxToPixelRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, { width: 100, height: 100 }, 0.05),
    ).toEqual({ x: 15, y: 15, width: 50, height: 50 })
  })

  it('keeps the padded rectangle inside the image', () => {
    expect(
      productBoxToPixelRect({ x: 0, y: 0, w: 1, h: 1 }, { width: 200, height: 100 }, 0.1),
    ).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('reports no rectangle for a box with no area', () => {
    expect(productBoxToPixelRect({ x: 0.5, y: 0.5, w: 0, h: 0.3 }, { width: 100, height: 100 })).toBeNull()
    expect(
      productBoxToPixelRect({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 }, { width: 100, height: 100 }, 0),
    ).toBeNull()
  })
})
