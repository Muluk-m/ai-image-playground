import { formatImageRatio } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  calculateImageSize,
  normalizeCodexCliImageSize,
  readSizeSelection,
  sameAspectRatio,
  sizeFor,
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

  it.each([
    ['4:1', '2160x720'],
    ['1:4', '720x2160'],
  ])('clamps custom ratio %s to the legal 3:1 boundary', (ratio, expected) => {
    expect(calculateImageSize('1K', ratio)).toBe(expected)
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

  describe('1K-limited normalization', () => {
    it.each([
      ['2048x2048', '1024x1024'],
      ['2560x1440', '1280x720'],
      ['1024x768', '1024x768'],
    ])('normalizes %s to %s', (size, expected) => {
      expect(normalizeCodexCliImageSize(size)).toBe(expected)
    })

    it('preserves non-pixel size values', () => {
      expect(normalizeCodexCliImageSize('auto')).toBe('auto')
    })
  })
})

const OPEN = { ratioOnly: false, limitTo1K: false }

describe('生成设置里尺寸对应哪一格', () => {
  it('auto 落在「智能」', () => {
    expect(readSizeSelection('auto', OPEN)).toEqual({ kind: 'auto' })
    expect(readSizeSelection('', OPEN)).toEqual({ kind: 'auto' })
  })

  it('预设尺寸回显成比例 + 分辨率档', () => {
    expect(readSizeSelection('2560x1440', OPEN)).toEqual({
      kind: 'preset',
      ratio: '16:9',
      tier: '2K',
    })
    expect(readSizeSelection('1024x1536', OPEN)).toEqual({
      kind: 'preset',
      ratio: '2:3',
      tier: '1K',
    })
  })

  it('预设外的宽高落在「自定义」，带约分后的比例', () => {
    expect(readSizeSelection('1600x1280', OPEN)).toEqual({ kind: 'custom', ratio: '5:4' })
  })

  it('只认比例的模型按比例匹配，存的比例本身也能回显', () => {
    const ratioOnly = { ratioOnly: true, limitTo1K: false }
    expect(readSizeSelection('2560x1440', ratioOnly)).toMatchObject({
      kind: 'preset',
      ratio: '16:9',
    })
    expect(readSizeSelection('3:4', ratioOnly)).toEqual({
      kind: 'preset',
      ratio: '3:4',
      tier: '1K',
    })
    expect(readSizeSelection('5:4', ratioOnly)).toEqual({ kind: 'custom', ratio: '5:4' })
  })

  it('Codex CLI 被上游重新量化的尺寸仍按比例认回预设', () => {
    const codex = { ratioOnly: false, limitTo1K: true }
    expect(readSizeSelection('941x1672', codex)).toMatchObject({ kind: 'preset', ratio: '9:16' })
  })
})

describe('选格写回的尺寸', () => {
  it('按当前分辨率档算预设尺寸', () => {
    expect(sizeFor('2K', '16:9', OPEN)).toBe('2560x1440')
    expect(sizeFor('4K', '1:1', OPEN)).toBe('2880x2880')
  })

  it('只认比例或限 1K 时一律按 1K 算', () => {
    expect(sizeFor('4K', '16:9', { ratioOnly: true, limitTo1K: false })).toBe('1280x720')
    expect(sizeFor('2K', '1:1', { ratioOnly: false, limitTo1K: true })).toBe('1024x1024')
  })
})
