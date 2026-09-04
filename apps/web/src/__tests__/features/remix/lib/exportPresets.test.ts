import { EXPORT_PRESETS, findExportPreset } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  computeCenterCrop,
  exportEntryName,
  sanitizePathSegment,
} from '../../../../features/remix/lib/exportPresets'

describe('the platform export presets', () => {
  it('covers the four store platforms', () => {
    expect(EXPORT_PRESETS.map((preset) => preset.id)).toEqual([
      'amazon',
      'alibaba',
      'pinduoduo',
      'site',
    ])
    expect(findExportPreset('amazon')).toMatchObject({ width: 2000, height: 2000 })
    expect(findExportPreset('pinduoduo')).toMatchObject({ width: 750, height: 1000 })
    expect(findExportPreset('nowhere')).toBeNull()
  })
})

describe('cropping a returned image to a preset', () => {
  it('keeps the whole frame when the ratios already match', () => {
    expect(computeCenterCrop({ width: 1122, height: 1122 }, { width: 2000, height: 2000 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 1122,
      sh: 1122,
    })
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
    expect(computeCenterCrop({ width: 1122, height: 1402 }, { width: 2000, height: 2000 })).toEqual({
      sx: 0,
      sy: 140,
      sw: 1122,
      sh: 1122,
    })
  })

  it('slides the crop to one edge at the extreme offset', () => {
    const source = { width: 1122, height: 1402 }
    const target = { width: 2000, height: 2000 }

    expect(computeCenterCrop(source, target, { x: 0, y: -1 }).sy).toBe(0)
    expect(computeCenterCrop(source, target, { x: 0, y: 1 }).sy).toBe(280)
  })

  it('clamps an offset that points past the edge', () => {
    const crop = computeCenterCrop({ width: 1254, height: 1254 }, { width: 750, height: 1000 }, {
      x: 4,
      y: 0,
    })

    expect(crop.sx).toBe(313)
    expect(crop.sx + crop.sw).toBeLessThanOrEqual(1254)
  })
})

describe('naming the files inside the export', () => {
  it('puts every shot under the set name', () => {
    expect(exportEntryName('奶油浴缸', 0, 'scene')).toBe('奶油浴缸/01-场景图.png')
    expect(exportEntryName('奶油浴缸', 11, 'main')).toBe('奶油浴缸/12-主图.png')
  })

  it('numbers the extra images of one shot', () => {
    expect(exportEntryName('奶油浴缸', 0, 'scene', 1)).toBe('奶油浴缸/01-场景图-2.png')
  })

  it('drops path separators from a name', () => {
    expect(sanitizePathSegment('a/b\\c')).toBe('a-b-c')
    expect(sanitizePathSegment('  ')).toBe('未命名')
  })
})
