import { describe, expect, it } from 'vitest'
import { centerCrop, plan, resizedSize } from '../../../../features/toolbox/lib/geometry'
import { collageLayout, sliceLayout, stitchLayout } from '../../../../features/toolbox/lib/layout'
import { searchQualityForSize } from '../../../../features/toolbox/lib/targetSize'

describe('plan', () => {
  it('swaps sides when rotated a quarter turn', () => {
    const result = plan(4000, 3000, { orientation: { rotate: 90, flipH: false, flipV: false } })
    expect([result.width, result.height]).toEqual([3000, 4000])
  })

  it('flags a platform size larger than the crop as upscaled', () => {
    const result = plan(2000, 1125, {
      crop: (w, h) => centerCrop(w, h, 1242 / 1660),
      output: () => ({ width: 1242, height: 1660 }),
    })
    expect(result.crop.height).toBe(1125)
    expect(result.upscaled).toBe(true)
  })
})

describe('resizedSize', () => {
  it('never enlarges by long edge, but honours an explicit width', () => {
    expect(resizedSize(800, 600, { mode: 'longEdge', value: 1600 })).toEqual({
      width: 800,
      height: 600,
    })
    expect(resizedSize(800, 600, { mode: 'width', value: 1600 })).toEqual({
      width: 1600,
      height: 1200,
    })
  })
})

describe('layouts', () => {
  it('stitches vertically at the narrowest width without enlarging', () => {
    const layout = stitchLayout(
      [
        { width: 1000, height: 500 },
        { width: 500, height: 500 },
      ],
      'vertical',
      10,
    )
    expect(layout.width).toBe(500)
    expect(layout.height).toBe(250 + 10 + 500)
  })

  it('packs a collage into rows with outer and inner gaps', () => {
    const sizes = Array.from({ length: 4 }, () => ({ width: 400, height: 300 }))
    const layout = collageLayout(sizes, 3, 5)
    expect([layout.width, layout.height]).toEqual([3 * 300 + 4 * 5, 2 * 300 + 3 * 5])
  })

  it('slices a landscape photo into nine squares after centring it', () => {
    const { source, tiles } = sliceLayout({ width: 1200, height: 900 }, 3, 3, true)
    expect(source).toEqual({ x: 150, y: 0 })
    expect(tiles).toHaveLength(9)
    expect(tiles[8]).toMatchObject({ x: 600, y: 600, width: 300, height: 300 })
  })
})

describe('searchQualityForSize', () => {
  const encodeAt = async (quality: number) => ({ size: Math.round(quality * 1000), quality })

  it('returns the highest quality that fits the target', async () => {
    const { result, overTarget } = await searchQualityForSize(encodeAt, 500)
    expect(overTarget).toBe(false)
    expect(result.size).toBeLessThanOrEqual(500)
    expect(result.size).toBeGreaterThan(480)
  })

  it('reports when even the lowest quality is too large', async () => {
    const { overTarget } = await searchQualityForSize(encodeAt, 10)
    expect(overTarget).toBe(true)
  })
})
