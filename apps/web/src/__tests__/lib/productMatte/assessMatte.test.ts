import { describe, expect, it } from 'vitest'
import { assessMatte } from '../../../lib/productMatte/assessMatte'
import type { ProductAlpha } from '../../../lib/productMatte/types'

/** 前 `productPixels` 个像素判为产品，其余为背景。 */
function matte(total: number, productPixels: number): ProductAlpha {
  const alpha = new Uint8ClampedArray(total)
  alpha.fill(255, 0, productPixels)
  return { alpha, width: total, height: 1 }
}

describe('assessMatte', () => {
  it('正常占比通过', () => {
    expect(assessMatte(matte(1000, 300))).toEqual({ ok: true, coverage: 0.3 })
  })

  it('产品占比过小判失败', () => {
    const result = assessMatte(matte(1000, 20))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('too-small')
    expect(result.coverage).toBeCloseTo(0.02)
  })

  it('产品占比过大判失败', () => {
    const result = assessMatte(matte(1000, 950))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('too-large')
    expect(result.coverage).toBeCloseTo(0.95)
  })

  it('全空遮罩判失败', () => {
    expect(assessMatte(matte(100, 0))).toEqual({ ok: false, coverage: 0, reason: 'too-small' })
  })

  it('边界值本身算通过', () => {
    expect(assessMatte(matte(1000, 30)).ok).toBe(true)
    expect(assessMatte(matte(1000, 900)).ok).toBe(true)
  })

  it('半透明像素按阈值计入产品', () => {
    const alpha = new Uint8ClampedArray(100)
    alpha.fill(200, 0, 50)
    alpha.fill(20, 50, 100)

    expect(assessMatte({ alpha, width: 10, height: 10 }).coverage).toBe(0.5)
  })
})
