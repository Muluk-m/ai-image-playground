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

it('retains antialiased diagonal slivers that contain no pixel centers', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
  pixels[(5 * 10 + 5) * 4 + 3] = 254
  const sliver = {
    id: 1,
    points: [
      { x: 0, y: 0.04 },
      { x: 0.95, y: 0.99 },
      { x: 0.94, y: 0.99 },
      { x: 0, y: 0.05 },
    ],
  }
  expect(visibleRegionBounds(pixels, 10, 10, [sliver])).toEqual([
    { id: 1, bounds: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
  ])
})

it('retains a horizontal sliver between pixel-center scanlines', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
  pixels[3 * 4 + 3] = 254
  const sliver = {
    id: 1,
    points: [
      { x: 0.1, y: 0.001 },
      { x: 0.9, y: 0.001 },
      { x: 0.9, y: 0.002 },
      { x: 0.1, y: 0.002 },
    ],
  }
  expect(visibleRegionBounds(pixels, 10, 10, [sliver])).toEqual([
    { id: 1, bounds: { x: 0.3, y: 0, width: 0.1, height: 0.1 } },
  ])
})

it('uses the same nonzero winding rule as Canvas when a lasso loops twice', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
  pixels[(2 * 10 + 2) * 4 + 3] = 0
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]
  expect(visibleRegionBounds(pixels, 10, 10, [{ id: 1, points }])).toEqual([
    { id: 1, bounds: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
  ])
})

it('bounds dense same-row lasso work across 32 regions', () => {
  const width = 1920,
    height = 1920
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  pixels[960 * 4 + 3] = 254
  const points = Array.from({ length: 2048 }, (_, i) => ({
    x: i < 1024 ? i / 1024 : (2047 - i) / 1024,
    y: i < 1024 ? 0.0001 : 0.0002,
  }))
  const started = performance.now()
  const regions = visibleRegionBounds(
    pixels,
    width,
    height,
    Array.from({ length: 32 }, (_, i) => ({ id: i + 1, points })),
  )
  expect(regions).toHaveLength(32)
  expect(regions[0]?.bounds).toEqual({ x: 0.5, y: 0, width: 1 / width, height: 1 / height })
  // Generous headroom for CI; the old repeated scan takes millions of edge
  // visits per region and exceeds this by orders of magnitude.
  expect(performance.now() - started).toBeLessThan(1000)
})
