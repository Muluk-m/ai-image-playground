import { describe, expect, it } from 'vitest'
import { batchCredits, batchPerImage, oversizedReferenceIndexes } from '../../lib/batchGenerate'

describe('per-image batch generation', () => {
  it('needs at least two images and runs per image once over the merge limit', () => {
    expect(batchPerImage(1, true, 16)).toBe(false)
    expect(batchPerImage(3, true, 16)).toBe(true)
    expect(batchPerImage(3, false, 16)).toBe(false)
    expect(batchPerImage(17, false, 16)).toBe(true)
  })

  it('flags references over the per-image limit by their position', () => {
    const small = { id: 'a', dataUrl: `data:image/png;base64,${'A'.repeat(8)}` }
    const big = { id: 'b', dataUrl: `data:image/png;base64,${'A'.repeat(400)}` }
    const remote = { id: 'c', dataUrl: 'aip-media:abc' }

    expect(oversizedReferenceIndexes([small, big, remote], 100)).toEqual([1])
  })

  it('prices the batch as images × the single-image price', () => {
    expect(batchCredits(3, 100)).toBe(300)
    expect(batchCredits(3, undefined)).toBeUndefined()
  })
})
