import { describe, expect, it } from 'vitest'
import {
  calculateImageSize,
  formatImageRatio,
  sameAspectRatio,
  sizeRatioLabel,
} from '../../lib/size'

describe('size ratio helpers', () => {
  it.each([
    ['1024x1824', '9:16'],
    ['auto', 'auto'],
    ['1024x1024', '1:1'],
  ])('formats %s as %s', (size, expected) => {
    expect(sizeRatioLabel(size)).toBe(expected)
  })

  it.each([
    { width: 1280, height: 1024, expected: '5:4' },
    { width: 1024, height: 1024, expected: '1:1' },
    { width: 1600, height: 900, expected: '16:9' },
    { width: 1824, height: 1024, expected: '≈16:9' },
  ])('formats $width×$height as $expected', ({ width, height, expected }) => {
    expect(formatImageRatio(width, height)).toBe(expected)
  })

  it('shows the intended common ratio for re-quantized dimensions', () => {
    expect(sizeRatioLabel('1824x1024')).toBe('16:9')
  })

  it('recovers a clamped 21:9 size without exposing a 7:3 alias', () => {
    expect(formatImageRatio(2048, 864)).toBe('≈21:9')
    expect(sizeRatioLabel('2048x864')).toBe('21:9')
  })

  it('marks a genuinely odd ratio as approximate', () => {
    expect(formatImageRatio(1000, 331)).toMatch(/^≈/)
  })

  it.each([
    '1:1',
    '3:2',
    '2:3',
    '16:9',
    '9:16',
    '4:3',
    '3:4',
    '21:9',
  ])('round-trips the %s picker preset through its calculated 1K size', (ratio) => {
    const size = calculateImageSize('1K', ratio)
    expect(size).not.toBeNull()
    expect(sizeRatioLabel(size!)).toBe(ratio)
  })

  it('accepts re-quantized pixels with the same aspect ratio', () => {
    expect(sameAspectRatio('1024x1824', '941x1672')).toBe(true)
  })

  it('rejects a changed aspect ratio', () => {
    expect(sameAspectRatio('1024x1824', '1254x1254')).toBe(false)
  })

  it('rejects non-pixel sizes', () => {
    expect(sameAspectRatio('auto', '941x1672')).toBe(false)
  })
})
