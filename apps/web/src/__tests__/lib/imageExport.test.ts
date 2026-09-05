import { describe, expect, it } from 'vitest'
import {
  computeCenterCrop,
  computeLetterbox,
  edgeAverageColor,
  sanitizePathSegment,
} from '../../lib/imageExport'

describe('cropping a returned image to a preset', () => {
  it('keeps the whole frame when the ratios already match', () => {
    expect(computeCenterCrop({ width: 1122, height: 1122 }, { width: 2000, height: 2000 })).toEqual(
      {
        sx: 0,
        sy: 0,
        sw: 1122,
        sh: 1122,
      },
    )
  })

  it('trims the sides when the frame is wider than the preset', () => {
    expect(computeCenterCrop({ width: 1254, height: 1254 }, { width: 750, height: 1000 })).toEqual({
      sx: 157,
      sy: 0,
      sw: 941,
      sh: 1254,
    })
  })

  it('trims top and bottom when the frame is taller than the preset', () => {
    expect(computeCenterCrop({ width: 1122, height: 1402 }, { width: 2000, height: 2000 })).toEqual(
      {
        sx: 0,
        sy: 140,
        sw: 1122,
        sh: 1122,
      },
    )
  })

  it('slides the crop to one edge at the extreme offset', () => {
    const source = { width: 1122, height: 1402 }
    const target = { width: 2000, height: 2000 }

    expect(computeCenterCrop(source, target, { x: 0, y: -1 }).sy).toBe(0)
    expect(computeCenterCrop(source, target, { x: 0, y: 1 }).sy).toBe(280)
  })

  it('clamps an offset that points past the edge', () => {
    const crop = computeCenterCrop(
      { width: 1254, height: 1254 },
      { width: 750, height: 1000 },
      {
        x: 4,
        y: 0,
      },
    )

    expect(crop.sx).toBe(313)
    expect(crop.sx + crop.sw).toBeLessThanOrEqual(1254)
  })
})

describe('padding a returned image out to a preset', () => {
  it('keeps the whole frame and centres it when the ratios differ', () => {
    expect(computeLetterbox({ width: 1000, height: 500 }, { width: 2000, height: 2000 })).toEqual({
      dx: 0,
      dy: 500,
      dw: 2000,
      dh: 1000,
    })
  })

  it('pads the sides when the frame is taller than the preset', () => {
    expect(computeLetterbox({ width: 1122, height: 1402 }, { width: 2000, height: 2000 })).toEqual({
      dx: 200,
      dy: 0,
      dw: 1601,
      dh: 2000,
    })
  })

  it('fills the frame when the ratios already match', () => {
    expect(computeLetterbox({ width: 1122, height: 1122 }, { width: 2000, height: 2000 })).toEqual({
      dx: 0,
      dy: 0,
      dw: 2000,
      dh: 2000,
    })
  })

  it('takes the padding colour from the border pixels', () => {
    const red = [255, 0, 0, 255]
    const blue = [0, 0, 255, 255]
    const pixels = new Uint8ClampedArray([red, red, red, red, blue, red, red, red, red].flat())

    expect(edgeAverageColor(pixels, { width: 3, height: 3 })).toBe('#ff0000')
  })

  it('pads with white when the border is transparent', () => {
    expect(edgeAverageColor(new Uint8ClampedArray(4 * 4), { width: 2, height: 2 })).toBe('#ffffff')
  })
})

describe('naming a file inside the export', () => {
  it('drops path separators from a name', () => {
    expect(sanitizePathSegment('a/b\\c')).toBe('a-b-c')
    expect(sanitizePathSegment('  ')).toBe('未命名')
  })
})
