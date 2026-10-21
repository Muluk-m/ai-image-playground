import { describe, expect, it } from 'vitest'
import {
  clampRatio,
  columnsForWidth,
  layoutMasonry,
  MASONRY_CAPTION_HEIGHT,
} from '../../../../features/inspiration/lib/masonry'

describe('masonry', () => {
  it('picks columns from the container width', () => {
    expect(columnsForWidth(1600)).toBe(6)
    expect(columnsForWidth(1200)).toBe(5)
    expect(columnsForWidth(800)).toBe(4)
    expect(columnsForWidth(600)).toBe(3)
    expect(columnsForWidth(400)).toBe(2)
  })

  it('clamps extreme ratios and falls back when the number is unusable', () => {
    expect(clampRatio(0.1)).toBe(0.56)
    expect(clampRatio(4)).toBe(1.9)
    expect(clampRatio(Number.NaN)).toBeCloseTo(0.75)
  })

  it('places cards in the shortest column without overlap', () => {
    const ratios = [1.4, 0.7, 1.2, 1.6, 0.8, 1.1, 1.5, 0.9]
    const layout = layoutMasonry(1200, ratios)
    expect(layout.columns).toBe(5)
    const occupied: Array<{ x: number; y: number; w: number; h: number }> = []
    for (const box of layout.boxes) {
      const height = box.imageHeight + MASONRY_CAPTION_HEIGHT
      for (const previous of occupied) {
        const separated =
          box.x + box.width <= previous.x ||
          previous.x + previous.w <= box.x ||
          box.y + height <= previous.y ||
          previous.y + previous.h <= box.y
        expect(separated).toBe(true)
      }
      occupied.push({ x: box.x, y: box.y, w: box.width, h: height })
    }
    const bottoms = new Map<number, number>()
    for (const box of layout.boxes) {
      const bottom = box.y + box.imageHeight + MASONRY_CAPTION_HEIGHT
      bottoms.set(box.x, Math.max(bottoms.get(box.x) ?? 0, bottom))
    }
    const values = [...bottoms.values()]
    const tallestCard =
      Math.max(...layout.boxes.map((box) => box.imageHeight)) + MASONRY_CAPTION_HEIGHT
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(tallestCard)
  })
})
