import { describe, expect, it } from 'vitest'
import { rgbaToNchw, scoresToAlpha } from '../../../lib/productMatte/matteTensor'

describe('rgbaToNchw', () => {
  it('按通道摊平并做 ImageNet 归一化', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255,
    ])

    const out = rgbaToNchw(rgba, 2)

    expect(out).toHaveLength(12)
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5)
    expect(out[4]).toBeCloseTo((0 - 0.456) / 0.224, 5)
    expect(out[10]).toBeCloseTo((1 - 0.406) / 0.225, 5)
  })
})

describe('scoresToAlpha', () => {
  it('sigmoid 后端把 logits 压回 0-255', () => {
    const alpha = scoresToAlpha([-10, 0, 10], 'sigmoid')

    expect(alpha[0]).toBe(0)
    expect(alpha[1]).toBe(128)
    expect(alpha[2]).toBe(255)
  })

  it('minmax 后端把分数拉满量程', () => {
    const alpha = scoresToAlpha([0.2, 0.4, 0.6], 'minmax')

    expect(Array.from(alpha)).toEqual([0, 128, 255])
  })

  it('输出全平时判定没有前景，不把噪声拉成整张产品', () => {
    const alpha = scoresToAlpha([0.3, 0.3, 0.3], 'minmax')

    expect(Array.from(alpha)).toEqual([0, 0, 0])
  })
})
