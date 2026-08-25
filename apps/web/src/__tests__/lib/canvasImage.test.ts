import { describe, expect, it } from 'vitest'
import { calculateFitSize } from '../../lib/canvasImage'

describe('calculateFitSize', () => {
  it('leaves images within the max edge untouched', () => {
    expect(calculateFitSize(1024, 2048, 2048)).toEqual({
      width: 1024,
      height: 2048,
      scale: 1,
      wasResized: false,
    })
  })

  it('scales the long edge down to the limit and keeps the aspect ratio', () => {
    expect(calculateFitSize(4032, 3024, 2048)).toEqual({
      width: 2048,
      height: 1536,
      scale: 2048 / 4032,
      wasResized: true,
    })
  })

  it('rounds each dimension down to the requested multiple', () => {
    expect(calculateFitSize(5000, 3333, 1920, 16)).toEqual({
      width: 1920,
      height: 1264,
      scale: 1920 / 5000,
      wasResized: true,
    })
  })

  it('never rounds a dimension below one multiple', () => {
    expect(calculateFitSize(100000, 1, 2048)).toMatchObject({ width: 2048, height: 1 })
    expect(calculateFitSize(100000, 1, 1920, 16)).toMatchObject({ height: 16 })
  })
})
