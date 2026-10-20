import { describe, expect, it } from 'vitest'
import {
  inspirationFeedOrder,
  seededShuffle,
} from '../../../../features/inspiration/lib/seededShuffle'
import type { InspirationItem } from '../../../../features/inspiration/types'

function item(id: string, thumbnailUrl = 'https://example.com/a.jpg'): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: id,
    prompt: 'prompt',
    thumbnailUrl,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    category: '摄影与写实',
  }
}

describe('seeded inspiration order', () => {
  it('keeps the same permutation for the same seed and does not mutate the input', () => {
    const source = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const first = seededShuffle(source, 7)
    const second = seededShuffle(source, 7)
    expect(first).toEqual(second)
    expect(source).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect([...first].sort()).toEqual([...source].sort())
  })

  it('changes order when the seed changes', () => {
    const source = Array.from({ length: 12 }, (_, index) => `id-${index}`)
    expect(seededShuffle(source, 1)).not.toEqual(seededShuffle(source, 2))
  })

  it('drops blanks and duplicate ids before shuffling', () => {
    const source = [item('keep'), item('drop', ''), item('keep'), item('other'), item('other')]
    const ordered = inspirationFeedOrder(source, 3)
    expect(ordered.map((entry) => entry.id)).toEqual(
      inspirationFeedOrder(source, 3).map((entry) => entry.id),
    )
    expect(new Set(ordered.map((entry) => entry.id))).toEqual(new Set(['keep', 'other']))
    expect(ordered).toHaveLength(2)
  })
})
