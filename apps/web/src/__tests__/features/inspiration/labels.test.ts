import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspirationFacetLabel, inspirationTitle } from '../../../features/inspiration/lib/labels'

interface ManifestItem {
  id: string
  category?: string
  tags?: string[]
  title?: string
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../public/inspiration-manifest.json'), 'utf8'),
) as { items: ManifestItem[] }

const HAN = /[\u3400-\u9fff]/

describe('inspiration facet labels', () => {
  it('translates every Chinese category and tag', () => {
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

  it('英文界面每个案例都显示英文标题，中文界面显示原标题', () => {
    for (const item of manifest.items) {
      const title = item.title ?? ''
      const english = inspirationTitle({ id: item.id, title }, 'en')
      expect(english, item.id).not.toMatch(HAN)
      expect(english.trim().length, item.id).toBeGreaterThan(0)
      expect(inspirationTitle({ id: item.id, title }, 'zh-CN')).toBe(title)
    }
  })

  it('后台改过标题或新案例没有译文时显示原标题', () => {
    const [first] = manifest.items
    expect(inspirationTitle({ id: first.id, title: '改过的标题' }, 'en')).toBe('改过的标题')
    expect(inspirationTitle({ id: 'not-in-map', title: '新案例' }, 'en')).toBe('新案例')
  })
})
