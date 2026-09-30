import { expect, it } from 'vitest'
import { visibleRegionBounds } from '../../../../features/agent/lib/regionBounds'

it('does not revive an erased lasso from a brush stroke outside its polygon', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
  pixels[(8 * 10 + 8) * 4 + 3] = 0
  const triangle = {
    id: 1,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  }
  expect(visibleRegionBounds(pixels, 10, 10, [triangle])).toEqual([])
  pixels[(2 * 10 + 2) * 4 + 3] = 0
  expect(visibleRegionBounds(pixels, 10, 10, [triangle])).toEqual([
    { id: 1, bounds: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
  ])
})

it('keeps overlapping polygons associated with their own surviving pixels', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
  pixels[(8 * 10 + 8) * 4 + 3] = 0
  const a = {
    id: 1,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  }
  const b = {
    id: 2,
    points: [
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
    ],
  }
  expect(visibleRegionBounds(pixels, 10, 10, [a, b])).toEqual([
    { id: 2, bounds: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 } },
  ])
})
