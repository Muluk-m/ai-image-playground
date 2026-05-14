import { describe, expect, it } from 'vitest'
import { pickFeaturedInspirations } from '../../../../features/inspiration/lib/pickFeatured'
import type { InspirationItem } from '../../../../features/inspiration/types'

function makeItem(overrides: Partial<InspirationItem> & { id: string }): InspirationItem {
  return {
    id: overrides.id,
    title: overrides.title ?? `Item ${overrides.id}`,
    prompt: overrides.prompt ?? 'a prompt',
    thumbnailUrl: overrides.thumbnailUrl ?? `https://example.com/${overrides.id}.jpg`,
    imageUrl: overrides.imageUrl,
    params: overrides.params ?? { size: '1024x1024' },
    recommendedProvider: overrides.recommendedProvider ?? 'openai-compat',
    recommendedModel: overrides.recommendedModel ?? 'gpt-image-2',
    category: overrides.category ?? 'misc',
    tags: overrides.tags,
    author: overrides.author,
    sourceUrl: overrides.sourceUrl,
    description: overrides.description,
  }
}

const FIXED_NOW = new Date('2026-05-14T12:00:00Z').getTime()

describe('pickFeaturedInspirations', () => {
  it('returns empty when items list is empty', () => {
    expect(pickFeaturedInspirations([], [], 3, FIXED_NOW)).toEqual([])
  })

  it('puts user-pinned items first', () => {
    const items = [
      makeItem({ id: 'a', category: 'people' }),
      makeItem({ id: 'b', category: 'scene' }),
      makeItem({ id: 'c', category: 'logo' }),
      makeItem({ id: 'd', category: 'poster' }),
    ]
    const result = pickFeaturedInspirations(items, ['c', 'a'], 3, FIXED_NOW)
    expect(result[0].id).toBe('c')
    expect(result[1].id).toBe('a')
    expect(result).toHaveLength(3)
  })

  it('stops at count when enough pinned items available', () => {
    const items = [
      makeItem({ id: 'a' }),
      makeItem({ id: 'b' }),
      makeItem({ id: 'c' }),
      makeItem({ id: 'd' }),
    ]
    const result = pickFeaturedInspirations(items, ['a', 'b', 'c', 'd'], 3, FIXED_NOW)
    expect(result.map((it) => it.id)).toEqual(['a', 'b', 'c'])
  })

  it('skips missing pinned ids gracefully', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })]
    const result = pickFeaturedInspirations(items, ['ghost', 'a', 'missing'], 2, FIXED_NOW)
    expect(result[0].id).toBe('a')
    expect(result).toHaveLength(2)
  })

  it('prefers category diversity when filling remainder', () => {
    const items = [
      makeItem({ id: 'people-1', category: 'people' }),
      makeItem({ id: 'people-2', category: 'people' }),
      makeItem({ id: 'people-3', category: 'people' }),
      makeItem({ id: 'scene-1', category: 'scene' }),
      makeItem({ id: 'logo-1', category: 'logo' }),
    ]
    const result = pickFeaturedInspirations(items, [], 3, FIXED_NOW)
    expect(result).toHaveLength(3)
    const categories = new Set(result.map((it) => it.category))
    expect(categories.size).toBe(3)
  })

  it('returns the same selection within the same day', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `item-${i}`, category: `cat-${i % 5}` }),
    )
    const a = pickFeaturedInspirations(items, [], 3, FIXED_NOW)
    const b = pickFeaturedInspirations(items, [], 3, FIXED_NOW + 60_000)
    expect(a.map((it) => it.id)).toEqual(b.map((it) => it.id))
  })

  it('changes selection across day boundaries', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      makeItem({ id: `item-${i}`, category: `cat-${i % 10}` }),
    )
    const dayA = pickFeaturedInspirations(items, [], 3, FIXED_NOW)
    const dayB = pickFeaturedInspirations(items, [], 3, FIXED_NOW + 86_400_000 * 3)
    expect(dayA.map((it) => it.id)).not.toEqual(dayB.map((it) => it.id))
  })

  it('falls back to leftovers when not enough distinct categories', () => {
    const items = [
      makeItem({ id: 'a', category: 'only' }),
      makeItem({ id: 'b', category: 'only' }),
      makeItem({ id: 'c', category: 'only' }),
    ]
    const result = pickFeaturedInspirations(items, [], 3, FIXED_NOW)
    expect(result).toHaveLength(3)
    expect(new Set(result.map((it) => it.id)).size).toBe(3)
  })

  it('never returns duplicates', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, category: `cat-${i % 3}` }),
    )
    const result = pickFeaturedInspirations(items, ['item-1', 'item-1', 'item-2'], 5, FIXED_NOW)
    const ids = result.map((it) => it.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns at most `count` items even when items abundant', () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      makeItem({ id: `item-${i}`, category: `cat-${i % 20}` }),
    )
    const result = pickFeaturedInspirations(items, [], 4, FIXED_NOW)
    expect(result).toHaveLength(4)
  })

  describe('preferredProvider', () => {
    const mixedItems: InspirationItem[] = [
      makeItem({ id: 'g1', category: 'a', recommendedProvider: 'gemini' }),
      makeItem({ id: 'g2', category: 'b', recommendedProvider: 'gemini' }),
      makeItem({ id: 'g3', category: 'c', recommendedProvider: 'gemini' }),
      makeItem({ id: 'o1', category: 'd', recommendedProvider: 'openai-compat' }),
      makeItem({ id: 'o2', category: 'e', recommendedProvider: 'openai-compat' }),
      makeItem({ id: 'o3', category: 'f', recommendedProvider: 'openai-compat' }),
      makeItem({ id: 'o4', category: 'g', recommendedProvider: 'openai-compat' }),
    ]

    it('only picks from preferredProvider pool when filling', () => {
      const result = pickFeaturedInspirations(mixedItems, [], 4, FIXED_NOW, {
        preferredProvider: 'openai-compat',
      })
      expect(result).toHaveLength(4)
      for (const item of result) {
        expect(item.recommendedProvider).toBe('openai-compat')
      }
    })

    it('honors pinned ids regardless of preferredProvider', () => {
      const result = pickFeaturedInspirations(mixedItems, ['g1', 'g2'], 4, FIXED_NOW, {
        preferredProvider: 'openai-compat',
      })
      expect(result[0].id).toBe('g1')
      expect(result[1].id).toBe('g2')
      const rest = result.slice(2)
      for (const item of rest) {
        expect(item.recommendedProvider).toBe('openai-compat')
      }
    })

    it('falls back to other providers when preferred pool runs out', () => {
      // 偏好池只有 2 张，要 4 张 → 应该补 2 张 gemini
      const limited: InspirationItem[] = [
        makeItem({ id: 'o1', category: 'a', recommendedProvider: 'openai-compat' }),
        makeItem({ id: 'o2', category: 'b', recommendedProvider: 'openai-compat' }),
        makeItem({ id: 'g1', category: 'c', recommendedProvider: 'gemini' }),
        makeItem({ id: 'g2', category: 'd', recommendedProvider: 'gemini' }),
      ]
      const result = pickFeaturedInspirations(limited, [], 4, FIXED_NOW, {
        preferredProvider: 'openai-compat',
      })
      expect(result).toHaveLength(4)
      const providers = result.map((it) => it.recommendedProvider)
      expect(providers.filter((p) => p === 'openai-compat')).toHaveLength(2)
      expect(providers.filter((p) => p === 'gemini')).toHaveLength(2)
    })

    it('no-op when preferredProvider matches everyone', () => {
      const onlyOpenai = mixedItems.filter((it) => it.recommendedProvider === 'openai-compat')
      const a = pickFeaturedInspirations(onlyOpenai, [], 3, FIXED_NOW, {
        preferredProvider: 'openai-compat',
      })
      const b = pickFeaturedInspirations(onlyOpenai, [], 3, FIXED_NOW)
      expect(a.map((it) => it.id)).toEqual(b.map((it) => it.id))
    })
  })
})
