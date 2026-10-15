import { describe, expect, it } from 'vitest'
import { seoFiles } from '../../seo'
import { alternatePage, editions, findPage, pageList } from '../catalog'
import { searchGuide, structuredData } from '../guideData'

describe('public page contract', () => {
  it('preserves every old guide URL and pairs both languages', () => {
    for (const edition of Object.values(editions)) {
      for (const path of [
        edition.root,
        ...edition.chapters.map((chapter) => `${edition.root}${chapter.id}/`),
      ]) {
        expect(findPage(path)?.kind).toBe('guide')
        expect(findPage(path.replace(/\/$/, ''))).toEqual(findPage(path))
      }
    }
    expect(new Set(pageList.map((page) => page.path)).size).toBe(pageList.length)
    for (const page of pageList) expect(alternatePage(alternatePage(page))).toEqual(page)
    expect(findPage('/guide/missing/')).toBeUndefined()
    expect(findPage('/p/private-project')).toBeUndefined()
  })
  it('does not publish login, workbench or private project URLs in the sitemap', () => {
    const files = seoFiles('https://example.com', true)
    expect(files['sitemap.xml']).toContain('https://example.com/en/create/video/')
    expect(files['sitemap.xml']).toContain('https://example.com/guide/create/')
    expect(files['sitemap.xml']).not.toMatch(
      /login|workbench|\/p\/|<loc>https:\/\/example.com\/image/,
    )
    expect(files['robots.txt']).toContain('Sitemap: https://example.com/sitemap.xml')
    expect(seoFiles('', true)['sitemap.xml']).toBeUndefined()
  })
  it('keeps internal and test builds out of search and LLM indexes', () => {
    const files = seoFiles('https://test.example.com', false)
    expect(files['robots.txt']).toContain('Disallow: /')
    expect(files['sitemap.xml']).toBeUndefined()
    expect(files['llms.txt']).toBeUndefined()
  })
  it('searches guide body text and FAQs with real anchor destinations', () => {
    expect(
      searchGuide(editions['zh-CN'], '遮罩').some(
        (item) => item.path === '/guide/create/#mask-edit',
      ),
    ).toBe(true)
    const faq = editions.en.faq.items[0]!
    expect(
      searchGuide(editions.en, faq.q).some(
        (item) => item.path === `/guide/en/#${editions.en.faq.id}`,
      ),
    ).toBe(true)
    expect(searchGuide(editions.en, '   ')).toEqual([])
  })
  it('describes only visible FAQs and actual procedures, excluding screenshot legends', () => {
    const page = findPage('/guide/getting-started/')!
    const data = structuredData(page, 'https://example.com')
    const faq = data.find((item) => item['@type'] === 'FAQPage') as {
      mainEntity: { name: string }[]
    }
    expect(faq.mainEntity.map((item) => item.name)).toEqual(
      editions['zh-CN'].chapters[0]!.faq!.map((item) => item.q),
    )
    expect(data.filter((item) => item['@type'] === 'HowTo').map((item) => item.name)).toEqual([
      '生成第一张图',
    ])
    expect(structuredData(page, '')).toEqual([])
    expect(structuredData(findPage('/login/')!, 'https://example.com')).toEqual([])
  })
})
