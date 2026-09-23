import { describe, expect, it } from 'vitest'
import { compressOutputType } from '../../../../features/toolbox/tools/compress'

describe('compressOutputType', () => {
  it('keeps lossy formats and moves PNG and undecodable-for-canvas formats to WebP', () => {
    expect(compressOutputType('auto', 'image/jpeg')).toBe('image/jpeg')
    expect(compressOutputType('auto', 'image/png')).toBe('image/webp')
    expect(compressOutputType('auto', 'image/heic')).toBe('image/webp')
    expect(compressOutputType('image/png', 'image/jpeg')).toBe('image/png')
  })
})
