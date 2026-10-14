import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guideEn } from '../../../features/guide/content/en'
import { guideZhCN } from '../../../features/guide/content/zh-CN'
import type { GuideContent } from '../../../features/guide/model'
import {
  buildSearchIndex,
  guidePagePath,
  renderGuidePage,
  renderInline,
} from '../../../features/guide/render'
import { guideHtmlEntries } from '../../../seo/vitePlugin'

const EDITIONS = [guideZhCN, guideEn]
const options = {
  origin: 'https://example.com',
  indexing: true,
  editions: EDITIONS,
  imageSize: () => ({ width: 1440, height: 900 }),
  updated: '2026-09-23',
}

/** 两种语言的页面、锚点、区块与截图必须一一对应：hreflang 按章节互指，截图编号按同一份结构讲解。 */
function shape(content: GuideContent) {
  return {
    chapters: content.chapters.map((chapter) => ({
      id: chapter.id,
      intro: chapter.intro?.map((block) => block.type),
      faq: chapter.faq?.length,
      subsections: chapter.subsections.map((sub) => ({
        id: sub.id,
        blocks: sub.blocks.map((block) =>
          block.type === 'shot'
            ? `shot:${block.src.split('/').pop()}:${block.marks?.length ?? 0}`
            : block.type,
        ),
      })),
    })),
    faq: content.faq.items.length,
  }
}

/** 全部页面：站内地址 → 渲染结果。 */
function renderAll() {
  return new Map(
    EDITIONS.flatMap((content) =>
      [null, ...content.chapters.map((c) => c.id)].map(
        (id) => [guidePagePath(content, id), renderGuidePage(content, id, options)] as const,
      ),
    ),
  )
}

describe('guide content', () => {
  it('keeps the Chinese and English editions structurally identical', () => {
    expect(shape(guideEn)).toEqual(shape(guideZhCN))
  })

  it('resolves every guide link to an existing page and anchor', () => {
    const pages = renderAll()
    for (const [from, html] of pages) {
      for (const [, href] of html.matchAll(/href="([^"]*#?[^"]*)"/g)) {
        if (!href.startsWith('/guide/') && !href.startsWith('#')) continue
        const [path, anchor] = href.split('#')
        const target = path ? pages.get(path) : pages.get(from)
        expect(target, `${from} links to missing page ${href}`).toBeDefined()
        if (anchor)
          expect(target, `${from} links to missing anchor ${href}`).toContain(`id="${anchor}"`)
      }
    }
  })

  it('has an HTML entry file for every page', () => {
    for (const file of Object.values(guideHtmlEntries(resolve(__dirname, '../../../..'))))
      expect(existsSync(file), file).toBe(true)
  })

  it('indexes every subsection and question for search with a link back to it', () => {
    const index = buildSearchIndex(guideZhCN)
    const questions = [
      ...guideZhCN.chapters.flatMap((chapter) => chapter.faq ?? []),
      ...guideZhCN.faq.items,
    ]
    const subsections = guideZhCN.chapters.flatMap((chapter) => chapter.subsections)
    expect(index).toHaveLength(subsections.length + questions.length)
    expect(index.filter((entry) => entry.url === '/guide/getting-started/#faq')).toHaveLength(
      guideZhCN.chapters[0]!.faq!.length,
    )
    const mask = index.find((entry) => entry.url === '/guide/create/#mask-edit')
    expect(mask?.text).toContain('遮罩编辑')
    expect(mask?.text).not.toMatch(/\[\[|\]\]|\*\*|\{\{/)
  })
})

describe('renderInline', () => {
  it('escapes raw HTML before applying guide markup', () => {
    expect(renderInline('<img src=x onerror=alert(1)> **粗**')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; <strong class="font-semibold text-foreground">粗</strong>',
    )
  })

  it('refuses links that are not site paths, anchors or https', () => {
    expect(() => renderInline('[x](javascript:alert(1))')).toThrow(/link must be/)
    expect(() => renderInline('[x](//evil.example)')).toThrow(/link must be/)
    expect(renderInline('[画布](/guide/canvas/)')).toContain('href="/guide/canvas/"')
  })
})

describe('renderGuidePage', () => {
  it('keeps FAQ text from closing the structured-data script', () => {
    const hostile: GuideContent = {
      ...guideZhCN,
      faq: { ...guideZhCN.faq, items: [{ q: '</script><script>alert(1)</script>', a: 'a' }] },
    }
    const html = renderGuidePage(hostile, null, options)
    const scripts = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) ?? []
    expect(scripts).toHaveLength(1)
    const data = JSON.parse(scripts[0]!.replace(/^<script[^>]*>|<\/script>$/g, ''))
    expect(
      data.find((item: { '@type': string }) => item['@type'] === 'FAQPage').mainEntity[0].name,
    ).toBe('</script><script>alert(1)</script>')
  })

  it('gives each chapter its own canonical URL and language alternates', () => {
    const html = renderGuidePage(guideEn, 'canvas', options)
    expect(html).toContain('<link rel="canonical" href="https://example.com/guide/en/canvas/" />')
    expect(html).toContain('hreflang="zh-CN" href="https://example.com/guide/canvas/"')
    expect(html).toContain('<a href="/guide/canvas/" hreflang="zh-CN"')
    expect(html).toContain(
      `<title>${guideEn.chapters.find((c) => c.id === 'canvas')!.meta.title}</title>`,
    )
    expect(html).not.toContain('noindex')
  })

  it('omits absolute URLs and blocks indexing when the site is private', () => {
    const html = renderGuidePage(guideZhCN, null, { ...options, origin: null, indexing: false })
    expect(html).not.toContain('rel="canonical"')
    expect(html).not.toContain('application/ld+json')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />')
  })

  it('describes the guide home with the visible page, breadcrumb and FAQ only', () => {
    const data = jsonLd(renderGuidePage(guideZhCN, null, options))
    expect(data.map((item) => item['@type'])).toEqual(['WebPage', 'BreadcrumbList', 'FAQPage'])
    const page = data[0] as { publisher: { '@id': string }; isPartOf: { '@id': string } }
    expect(page.publisher['@id']).toBe('https://example.com/#organization')
    expect(page.isPartOf['@id']).toBe('https://example.com/#website')
    const faq = data.find((item) => item['@type'] === 'FAQPage') as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[]
    }
    expect(faq.mainEntity.map((item) => item.name)).toEqual(
      guideZhCN.faq.items.map((item) => item.q),
    )
    expect(faq.mainEntity.map((item) => item.acceptedAnswer.text)).toEqual(
      guideZhCN.faq.items.map((item) => item.a),
    )
    expect(JSON.stringify(data)).not.toContain('有没有贴商品链接就能生成主图')
  })

  it('marks real procedures as HowTo and leaves screenshot legends out', () => {
    const zh = jsonLd(renderGuidePage(guideZhCN, 'getting-started', options))
    const en = jsonLd(renderGuidePage(guideEn, 'getting-started', options))
    const zhHowTo = zh.filter((item) => item['@type'] === 'HowTo')
    const enHowTo = en.filter((item) => item['@type'] === 'HowTo')
    expect(zhHowTo).toHaveLength(enHowTo.length)
    expect(zhHowTo.map((item) => item.name)).toEqual(['生成第一张图'])
    expect(enHowTo.map((item) => item.name)).toEqual(['Generate your first image'])
    expect(zh.map((item) => item['@type'])).toContain('TechArticle')
    expect(zh.map((item) => item['@type'])).toContain('BreadcrumbList')
    expect(zh.map((item) => item['@type'])).toContain('FAQPage')

    const howTo = zhHowTo[0] as {
      url: string
      step: { position: number; text: string }[]
      description: string
    }
    expect(howTo.url).toBe('https://example.com/guide/getting-started/#first-image')
    expect(howTo.description).toBe('在首页确认输入框上方已选中 快速生成，然后描述画面内容，例如：')
    expect(howTo.step.map((step) => step.text)).toEqual([
      '按需设置 比例 与 数量。',
      '点击 生成 或按 Enter 提交。',
      '任务会出现在 我的作品 顶部，依次显示 排队中...、生成中...，完成后自动展示结果。',
    ])
    expect(howTo.step.map((step) => step.position)).toEqual([1, 2, 3])
    expect(howTo.step.some((step) => /\[\[|\{\{/.test(step.text))).toBe(false)

    const canvas = jsonLd(renderGuidePage(guideZhCN, 'canvas', options))
    const names = canvas.filter((item) => item['@type'] === 'HowTo').map((item) => item.name)
    expect(names).toContain('标注修改')
    expect(names).not.toContain('基本操作')
  })
})

function jsonLd(html: string): Record<string, unknown>[] {
  const scripts = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) ?? []
  expect(scripts).toHaveLength(1)
  return JSON.parse(scripts[0]!.replace(/^<script[^>]*>|<\/script>$/g, ''))
}
