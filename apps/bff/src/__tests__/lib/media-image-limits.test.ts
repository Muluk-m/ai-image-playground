import { expect, it } from 'bun:test'
import { assertMediaImageProcessingBudget, displayedImageSize } from '../../lib/media-image-limits'

const png = {
  format: 'png',
  width: 3000,
  height: 2700,
  channels: 4,
  depth: 'uchar',
  isProgressive: false,
} as const

it('allows large streaming images but rejects tiny files with dangerous scanline widths', () => {
  expect(() =>
    assertMediaImageProcessingBudget({ ...png, width: 31622, height: 31622, depth: 'ushort' }),
  ).not.toThrow()
  expect(() => assertMediaImageProcessingBudget({ ...png, width: 1_000_000, height: 100 })).toThrow(
    'processing_budget',
  )
})

it('distinguishes progressive allocation from streaming the same image dimensions', () => {
  const large = { ...png, width: 10000, height: 10000, depth: 'ushort' } as const
  expect(() => assertMediaImageProcessingBudget(large)).not.toThrow()
  expect(() => assertMediaImageProcessingBudget({ ...large, isProgressive: true })).toThrow(
    'processing_budget',
  )
  expect(() => assertMediaImageProcessingBudget({ ...png, isProgressive: true })).not.toThrow()
})

it('budgets full-frame WebP buffers even without progressive scans', () => {
  const webp = { ...png, format: 'webp', width: 12000, height: 12000 } as const
  expect(() => assertMediaImageProcessingBudget(webp)).toThrow('processing_budget')
  expect(() =>
    assertMediaImageProcessingBudget({ ...webp, width: 10000, height: 10000 }),
  ).not.toThrow()
  expect(() => assertMediaImageProcessingBudget({ ...webp, format: 'png' })).not.toThrow()
})

it('EXIF 方向 5–8 的图按转正后的宽高记，其余照存储宽高', () => {
  for (const orientation of [5, 6, 7, 8])
    expect(displayedImageSize({ width: 4032, height: 3024, orientation })).toEqual({
      width: 3024,
      height: 4032,
    })
  for (const orientation of [undefined, 1, 2, 3, 4])
    expect(displayedImageSize({ width: 4032, height: 3024, orientation })).toEqual({
      width: 4032,
      height: 3024,
    })
})
