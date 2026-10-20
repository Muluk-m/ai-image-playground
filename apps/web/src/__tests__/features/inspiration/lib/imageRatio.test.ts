import { beforeEach, describe, expect, it } from 'vitest'
import {
  aspectLabel,
  clearRatioCache,
  dimensionsForItem,
  inspirationImageUrl,
  ratioForItem,
  rememberRatio,
} from '../../../../features/inspiration/lib/imageRatio'
import type { InspirationItem } from '../../../../features/inspiration/types'

function item(extra: Partial<InspirationItem> = {}): InspirationItem {
  return {
    id: 'card',
    kind: 'showcase',
    title: 'Card',
    prompt: 'prompt',
    thumbnailUrl: 'https://example.com/card.jpg',
    params: { size: '1024x1536' },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category: '摄影与写实',
    ...extra,
  }
}

describe('image ratios', () => {
  beforeEach(() => clearRatioCache())

  it('prefers a remembered measurement over the manifest and params', () => {
    rememberRatio('card', 800, 800)
    expect(dimensionsForItem(item({ thumbWidth: 400, thumbHeight: 600 }))).toEqual({
      width: 800,
      height: 800,
    })
  })

  it('uses manifest dimensions before params.size, and ignores auto', () => {
    expect(
      dimensionsForItem(item({ thumbWidth: 400, thumbHeight: 600, params: { size: 'auto' } })),
    ).toEqual({ width: 400, height: 600 })
    expect(dimensionsForItem(item({ width: 200, height: 100 }))).toEqual({
      width: 200,
      height: 100,
    })
    expect(ratioForItem(item({ params: { size: 'auto' } }))).toBeCloseTo(0.75)
  })

  it('names common aspects and rewrites only cms-r2 widths', () => {
    expect(aspectLabel(1600, 900)).toBe('16:9')
    expect(aspectLabel(1000, 1000)).toBe('1:1')
    expect(
      inspirationImageUrl('https://cms-r2.deepclick.com/image-playground-banana/19778.jpg', 480),
    ).toBe('https://cms-r2.deepclick.com/image-playground-banana/19778.jpg?w=480')
    expect(inspirationImageUrl('https://example.com/a.jpg', 480)).toBe('https://example.com/a.jpg')
  })
})
