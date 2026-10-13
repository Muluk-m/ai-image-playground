import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspirationFacetLabel } from '../../../features/inspiration/lib/labels'

interface ManifestItem {
  category?: string
  tags?: string[]
  title?: string
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../public/inspiration-manifest.json'), 'utf8'),
) as { items: ManifestItem[] }

const HAN = /[\u3400-\u9fff]/

describe('inspiration facet labels', () => {
  it('translates every Chinese category and tag, and leaves titles alone', () => {
    const facets = new Set<string>()
    for (const item of manifest.items) {
      if (item.category) facets.add(item.category)
      for (const tag of item.tags ?? []) facets.add(tag)
    }
    for (const facet of facets) {
      const english = inspirationFacetLabel(facet, 'en')
      if (HAN.test(facet)) expect(english, facet).not.toMatch(HAN)
      else expect(english).toBe(facet)
      expect(inspirationFacetLabel(facet, 'zh-CN')).toBe(facet)
    }
    expect(facets.size).toBeGreaterThan(20)
  })
})
