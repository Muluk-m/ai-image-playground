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
  it('does not force a previously shown edit into a full unseen batch', () => {
    const items = [
      item('poster-1', 'Poster'),
      item('poster-2', 'Poster', true),
      ...Array.from({ length: 7 }, (_, index) => item(`other-${index}`, `Category ${index}`)),
    ]

    const result = selectHeroItems(items, ['poster-2'])

    expect(result).toHaveLength(6)
    expect(result.some((entry) => entry.id === 'poster-2')).toBe(false)
  })

  it('uses just one two-column image edit in a six-column hero', () => {
    const items = [
      item('edit-1', 'Illustration', true),
      item('edit-2', 'Architecture', true),
      ...Array.from({ length: 5 }, (_, index) => item(`single-${index}`, `Category ${index}`)),
    ]

    const result = selectHeroItems(items)

    expect(result).toHaveLength(5)
    expect(result.filter((entry) => entry.referenceImages?.length)).toHaveLength(1)
  })

  it('rotates to an unseen edit when the previous batch included another one', () => {
    const items = [
      item('edit-1', 'Illustration', true),
      item('edit-2', 'Architecture', true),
      ...Array.from({ length: 6 }, (_, index) => item(`single-${index}`, `Category ${index}`)),
    ]

    const result = selectHeroItems(items, ['edit-1'])

    expect(result).toHaveLength(5)
    expect(result[0]?.id).toBe('edit-2')
  })
})
