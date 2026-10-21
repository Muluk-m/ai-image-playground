import { describe, expect, it } from 'vitest'
import { guideEntries } from '../../../web/src/features/guide/model'
import { seoFiles } from '../../seo'
import { alternatePage, counterpartPage, editions, findPage, pageList, pageMeta } from '../catalog'
import { searchGuide, structuredData } from '../guideData'

describe('public page contract', () => {
  it('serves every guide page, redirects old chapter URLs and pairs both languages', () => {
    for (const edition of Object.values(editions)) {
      for (const path of [edition.root, ...guideEntries(edition).map((entry) => entry.path)]) {
        expect(findPage(path)?.kind).toBe('guide')
        expect(findPage(path.replace(/\/$/, ''))).toEqual(findPage(path))
      }
      for (const chapter of ['getting-started', 'create', 'canvas', 'agent', 'assets']) {
        const moved = findPage(`${edition.root}${chapter}/`)
        expect(moved?.kind).toBe('moved')
        expect(findPage(moved!.movedTo!)?.kind).toBe('guide')
      }
    }
    expect(new Set(pageList.map((page) => page.path)).size).toBe(pageList.length)
    for (const page of pageList) {
      const other = counterpartPage(page)
      if (other) expect(counterpartPage(other)).toEqual(page)
      expect(alternatePage(page).locale).not.toBe(page.locale)
    }
    expect(counterpartPage(findPage('/guide/create/composer/')!)?.path).toBe(
      '/guide/en/create/composer/',
    )
    expect(findPage('/guide/missing/')).toBeUndefined()
    expect(findPage('/p/private-project')).toBeUndefined()
  })
  it('names the marketing home after the v4.1 hero', () => {
    const zh = pageMeta(findPage('/')!)
    expect(zh.title).toContain('说出你要的画面')
    expect(zh.title).toContain('剩下的交给幕芽')
    expect(zh.title).toContain('AI 图片、视频与画布创作平台')
    expect(zh.title).not.toContain('故事，由你发生')
    const en = pageMeta(findPage('/en/')!)
    expect(en.title).toContain('Say the picture you want')
    expect(en.title).toContain('AI Image, Video and Canvas Creation')
    expect(en.title).not.toContain('Your story starts here')
  })
  it('does not publish login, workbench or private project URLs in the sitemap', () => {
    const files = seoFiles('https://example.com', true)
    expect(files['sitemap.xml']).toContain('https://example.com/en/create/video/')
    expect(files['sitemap.xml']).toContain('https://example.com/guide/create/settings/')
    expect(files['sitemap.xml']).not.toContain('https://example.com/guide/create/<')
    expect(files['llms.txt']).not.toContain('/guide/getting-started/')
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
      searchGuide(editions['zh-CN'], '防改写').some(
        (item) => item.path === '/guide/create/settings/#adjust-settings',
      ),
    ).toBe(true)
    const faqPage = guideEntries(editions.en).find((entry) => entry.key === 'help/faq')!
    const faqBlock = faqPage.page.sections[0]!.blocks[0]!
    if (faqBlock.type !== 'faq') throw new Error('expected faq block')
    expect(
      searchGuide(editions.en, faqBlock.items[0]!.q).some(
        (item) => item.path === '/guide/en/help/faq/#faq',
      ),
    ).toBe(true)
    expect(searchGuide(editions.en, '   ')).toEqual([])
  })
  it('describes visible FAQs, procedures and breadcrumbs; moved pages carry none', () => {
    const faqData = structuredData(findPage('/guide/help/faq/')!, 'https://example.com')
    const faq = faqData.find((item) => item['@type'] === 'FAQPage') as {
      mainEntity: { name: string }[]
    }
    expect(faq.mainEntity[0]!.name).toBe('点击发送后弹出登录窗口，没有开始生成？')
    const page = findPage('/guide/create/settings/')!
    const data = structuredData(page, 'https://example.com')
    expect(data.filter((item) => item['@type'] === 'HowTo').map((item) => item.name)).toContain(
      '打开生成设置',
    )
    expect(data.some((item) => item['@type'] === 'BreadcrumbList')).toBe(true)
    expect(data.some((item) => item['@type'] === 'FAQPage')).toBe(false)
    expect(structuredData(page, '')).toEqual([])
    expect(structuredData(findPage('/guide/create/')!, 'https://example.com')).toEqual([])
    expect(structuredData(findPage('/login/')!, 'https://example.com')).toEqual([])
  })
})
