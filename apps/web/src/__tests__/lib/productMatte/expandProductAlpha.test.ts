import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ALPHA_THRESHOLD,
  DEFAULT_MATTE_GROW_RATIO,
  expandProductAlpha,
} from '../../../lib/productMatte/expandProductAlpha'
import type { ProductAlpha } from '../../../lib/productMatte/types'

function blank(width: number, height: number): ProductAlpha {
  return { alpha: new Uint8ClampedArray(width * height), width, height }
}

function paint(matte: ProductAlpha, rect: Rect, value: number): ProductAlpha {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) matte.alpha[y * matte.width + x] = value
  }
  return matte
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function at(matte: ProductAlpha, x: number, y: number): number {
  return matte.alpha[y * matte.width + x]
}

function productPixels(matte: ProductAlpha): number {
  return matte.alpha.reduce((count, value) => (value > 0 ? count + 1 : count), 0)
}

describe('growing the product alpha', () => {
  it('grows the product by the given share of the image width', () => {
    const matte = paint(blank(100, 100), { x: 50, y: 50, w: 1, h: 1 }, 255)

    const grown = expandProductAlpha(matte, { growRatio: 0.05 })

    // 半径 5 的方形核：11×11
    expect(productPixels(grown)).toBe(11 * 11)
    expect(at(grown, 45, 50)).toBe(255)
    expect(at(grown, 44, 50)).toBe(0)
  })

  it('leaves the alpha binary so the mask threshold sees a hard edge', () => {
    const matte = paint(blank(40, 40), { x: 10, y: 10, w: 10, h: 10 }, 200)

    const grown = expandProductAlpha(matte, { growRatio: 0 })

    expect(new Set(grown.alpha)).toEqual(new Set([0, 255]))
    expect(grown.width).toBe(40)
    expect(grown.height).toBe(40)
  })

  it('keeps the default growth at 1.5% of the image width', () => {
    expect(DEFAULT_MATTE_GROW_RATIO).toBe(0.015)

    const matte = paint(blank(200, 200), { x: 100, y: 100, w: 1, h: 1 }, 255)

    expect(productPixels(expandProductAlpha(matte))).toBe(7 * 7)
  })
})

describe('pulling the attachments back into the product', () => {
  /** 客户源图：落地龙头在显著性图上只剩弱响应，膨胀后仍在重绘区里。 */
  const BOX = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }

  function tubWithFaucet(): ProductAlpha {
    const matte = paint(blank(100, 100), { x: 30, y: 50, w: 40, h: 30 }, 255)
    return paint(matte, { x: 72, y: 20, w: 3, h: 30 }, ATTACHMENT_ALPHA_THRESHOLD + 10)
  }

  it('merges a thin weak region that touches the grown product', () => {
    const expanded = expandProductAlpha(tubWithFaucet(), { growRatio: 0.03, productBox: BOX })

    expect(at(expanded, 73, 25)).toBe(255)
  })

  it('leaves a thin weak region that the product does not reach', () => {
    const matte = paint(blank(100, 100), { x: 30, y: 50, w: 40, h: 30 }, 255)
    paint(matte, { x: 80, y: 10, w: 3, h: 30 }, ATTACHMENT_ALPHA_THRESHOLD + 10)

    const expanded = expandProductAlpha(matte, { growRatio: 0.01, productBox: BOX })

    expect(at(expanded, 81, 15)).toBe(0)
  })

  it('leaves a chunky weak region alone: an attachment is thin, a second object is not', () => {
    const matte = paint(blank(100, 100), { x: 30, y: 50, w: 40, h: 30 }, 255)
    paint(matte, { x: 71, y: 20, w: 18, h: 25 }, ATTACHMENT_ALPHA_THRESHOLD + 10)

    const expanded = expandProductAlpha(matte, { growRatio: 0.03, productBox: BOX })

    expect(at(expanded, 85, 25)).toBe(0)
  })

  it('leaves weak regions outside the product box alone', () => {
    const matte = paint(blank(100, 100), { x: 30, y: 50, w: 40, h: 30 }, 255)
    paint(matte, { x: 72, y: 0, w: 3, h: 50 }, ATTACHMENT_ALPHA_THRESHOLD + 10)

    const expanded = expandProductAlpha(matte, {
      growRatio: 0.03,
      productBox: { x: 0.3, y: 0.5, w: 0.4, h: 0.3 },
    })

    expect(at(expanded, 73, 25)).toBe(0)
  })

  it('merges nothing when the plan gave no product box', () => {
    const expanded = expandProductAlpha(tubWithFaucet(), { growRatio: 0.03 })

    expect(at(expanded, 73, 25)).toBe(0)
  })
})
