import { describe, expect, it } from 'vitest'
import {
  assertUsableMaskCoverage,
  classifyMaskAlpha,
  maskPaintOperation,
  orderInputImagesForMask,
  validateMaskTarget,
} from '../../lib/mask'
import type { InputImage } from '../../types'

function img(id: string): InputImage {
  return { id, dataUrl: `data:image/png;base64,${id}` }
}

function alphaImageData(alphaValues: number[]): ImageData {
  const data = new Uint8ClampedArray(alphaValues.length * 4)
  alphaValues.forEach((alpha, idx) => {
    data[idx * 4] = 255
    data[idx * 4 + 1] = 255
    data[idx * 4 + 2] = 255
    data[idx * 4 + 3] = alpha
  })
  return { data, width: alphaValues.length, height: 1, colorSpace: 'srgb' } as ImageData
}

describe('orderInputImagesForMask', () => {
  it('moves the mask target to the first request image without dropping references', () => {
    const ordered = orderInputImagesForMask([img('a'), img('b'), img('c')], 'b')
    expect(ordered.map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })

  it('preserves order when the mask target is already first', () => {
    const ordered = orderInputImagesForMask([img('a'), img('b')], 'a')
    expect(ordered.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('throws when the target image is not present', () => {
    expect(() => orderInputImagesForMask([img('a')], 'missing')).toThrow('遮罩主图已不存在')
  })
})

describe('validateMaskTarget', () => {
  it('returns the target image when present', () => {
    expect(validateMaskTarget([img('a'), img('b')], 'b').id).toBe('b')
  })

  it('throws for an empty target id', () => {
    expect(() => validateMaskTarget([img('a')], '')).toThrow('遮罩主图已不存在')
  })
})

describe('classifyMaskAlpha', () => {
  it('classifies no transparent pixels as empty', () => {
    expect(classifyMaskAlpha(alphaImageData([255, 255, 255]))).toBe('empty')
  })

  it('classifies all transparent pixels as full', () => {
    expect(classifyMaskAlpha(alphaImageData([0, 0, 0]))).toBe('full')
  })

  it('classifies mixed alpha values as partial', () => {
    expect(classifyMaskAlpha(alphaImageData([255, 0, 128]))).toBe('partial')
  })
})

describe('assertUsableMaskCoverage', () => {
  it('rejects masks with no edit area', () => {
    expect(() => assertUsableMaskCoverage('empty')).toThrow('请先涂抹需要编辑的区域')
  })

  it('allows partial masks', () => {
    expect(() => assertUsableMaskCoverage('partial')).not.toThrow()
  })

  it('allows full masks so the UI can confirm before submit', () => {
    expect(() => assertUsableMaskCoverage('full')).not.toThrow()
  })
})

describe('which way the brush paints', () => {
  it('paints the repaint area in the composer', () => {
    expect(maskPaintOperation('brush', false)).toBe('destination-out')
    expect(maskPaintOperation('eraser', false)).toBe('source-over')
  })

  /** 商品图的蒙版是保留区：涂龙头是把它加进保留区，不是划成重绘。 */
  it('paints the kept area when the caller asked for keep semantics', () => {
    expect(maskPaintOperation('brush', true)).toBe('source-over')
    expect(maskPaintOperation('eraser', true)).toBe('destination-out')
  })
})
