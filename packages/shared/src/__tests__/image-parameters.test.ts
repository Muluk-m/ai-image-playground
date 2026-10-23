import { describe, expect, it } from 'bun:test'
import { nearestImageSize } from '../image-parameters'

describe('nearestImageSize', () => {
  it.each([
    ['1K', ['1K', '2K'], '1K'],
    ['512', ['1K', '2K'], '1K'],
    ['4K', ['1K', '2K'], '2K'],
    ['2K', ['1K'], '1K'],
    ['512', ['1K'], '1K'],
    // 距离相同取低的一档：不多扣、不多等。
    ['1K', ['512', '2K'], '512'],
    // 声明顺序乱也按档位高低比。
    ['4K', ['2K', '1K'], '2K'],
  ] as const)('maps %s onto %j as %s', (value, supported, expected) => {
    expect(nearestImageSize(value, supported)).toBe(expected)
  })

  it.each([['8K'], ['huge'], [2], [null]])('gives the lowest declared tier for %p', (value) => {
    expect(nearestImageSize(value, ['2K', '1K'])).toBe('1K')
  })

  it('has nothing to offer when no tier is declared', () => {
    expect(nearestImageSize('1K', [])).toBeUndefined()
  })
})
