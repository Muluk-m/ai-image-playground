import { expect, it } from 'vitest'
import { suggestedInspirations } from '../../../../features/inspiration/lib/suggestedInspirations'
import type { InspirationItem } from '../../../../features/inspiration/types'

function item(id: string): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: id,
    category: 'Product',
    prompt: 'Create an image',
    thumbnailUrl: `https://example.com/${id}.png`,
    params: { size: 'auto' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
  }
}
it('samples unique prompt-only inspirations without changing the shared library', () => {
  const items = [
    ...Array.from({ length: 8 }, (_, index) => item(String(index))),
    { ...item('edit'), referenceImages: [{ url: 'https://example.com/input.png', name: 'input' }] },
    { ...item('empty'), prompt: '' },
  ]
  const ids = items.map((item) => item.id)
  const result = suggestedInspirations(items, () => 0)
  expect(result).toHaveLength(3)
  expect(new Set(result.map((item) => item.id)).size).toBe(3)
  expect(result.every((item) => !['edit', 'empty'].includes(item.id))).toBe(true)
  expect(items.map((item) => item.id)).toEqual(ids)
})
it('handles a short or empty library', () => {
  expect(suggestedInspirations([])).toEqual([])
  expect(suggestedInspirations([item('only')])).toEqual([item('only')])
})
