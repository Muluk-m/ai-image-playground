import { expect, it } from 'bun:test'
import { assertMediaImageProcessingBudget } from '../../lib/media-image-limits'

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
