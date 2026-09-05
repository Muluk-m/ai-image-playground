import { EXPORT_PRESETS, findExportPreset } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { defaultExportFit, exportEntryName } from '../../../../features/remix/lib/exportPresets'

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

  it('pads the selling point shot and crops the others', () => {
    expect(defaultExportFit('selling-point')).toBe('letterbox')
    expect(defaultExportFit('main')).toBe('crop')
    expect(defaultExportFit('scene')).toBe('crop')
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
})
