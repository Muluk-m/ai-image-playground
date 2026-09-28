import { describe, expect, it } from 'vitest'
import { selectHeroItems } from '../../../../features/inspiration/lib/heroRotation'
import type { InspirationItem } from '../../../../features/inspiration/types'

function item(id: string, category: string, withInput = false): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: id,
    prompt: 'Create an image',
    thumbnailUrl: `https://example.com/${id}.png`,
    params: { size: 'auto' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    category,
    ...(withInput
      ? { referenceImages: [{ url: `https://example.com/${id}-before.png`, name: 'Input' }] }
      : {}),
  }
}

describe('home inspiration rotation', () => {
  it('keeps a real image edit visible even when its category was already represented', () => {
    const items = [
      item('poster-1', 'Poster'),
      item('poster-2', 'Poster', true),
      ...Array.from({ length: 7 }, (_, index) => item(`other-${index}`, `Category ${index}`)),
    ]

    const result = selectHeroItems(items, ['poster-2'])

    expect(result).toHaveLength(6)
    expect(result.some((entry) => entry.id === 'poster-2')).toBe(true)
  })
})
