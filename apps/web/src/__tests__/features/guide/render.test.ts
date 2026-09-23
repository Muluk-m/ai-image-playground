import { describe, expect, it } from 'vitest'
import { guideEn } from '../../../features/guide/content/en'
import { guideZhCN } from '../../../features/guide/content/zh-CN'
import type { GuideContent } from '../../../features/guide/model'
import { renderGuideDocument, renderInline } from '../../../features/guide/render'

const options = {
  origin: 'https://example.com',
  indexing: true,
  alternates: [
    { lang: 'zh-CN' as const, path: '/guide/' },
    { lang: 'en' as const, path: '/guide/en/' },
  ],
  imageSize: () => ({ width: 1440, height: 900 }),
  updated: '2026-09-23',
}

/** 两种语言的锚点、区块与截图必须一一对应：hreflang 互指、目录与截图编号都按同一份结构走。 */
function shape(content: GuideContent) {
  return {
    sections: content.sections.map((section) => ({
      id: section.id,
      intro: section.intro?.map((block) => block.type),
      subsections: section.subsections.map((sub) => ({
        id: sub.id,
        blocks: sub.blocks.map((block) =>
          block.type === 'shot'
            ? `shot:${block.src.split('/').pop()}:${block.marks?.length ?? 0}`
            : block.type,
        ),
      })),
    })),
    quickStart: content.quickStart.items.map((item) => item.href),
    faq: content.faq.items.length,
  }
}

describe('guide content', () => {
  it('keeps the Chinese and English editions structurally identical', () => {
    expect(shape(guideEn)).toEqual(shape(guideZhCN))
  })

  it('uses unique anchors that every in-page link resolves to', () => {
    for (const content of [guideZhCN, guideEn]) {
      const ids = [
        ...content.sections.flatMap((section) => [
          section.id,
          ...section.subsections.map((sub) => sub.id),
        ]),
        content.faq.id,
      ]
      expect(new Set(ids).size).toBe(ids.length)
      const html = renderGuideDocument(content, options)
      for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g))
        if (anchor !== 'top') expect(ids).toContain(anchor)
    }
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
    expect(renderInline('[画布](#canvas)')).toContain('href="#canvas"')
  })
})

describe('renderGuideDocument', () => {
  it('keeps FAQ text from closing the structured-data script', () => {
    const hostile: GuideContent = {
      ...guideZhCN,
      faq: { ...guideZhCN.faq, items: [{ q: '</script><script>alert(1)</script>', a: 'a' }] },
    }
    const html = renderGuideDocument(hostile, options)
    const scripts = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) ?? []
    expect(scripts).toHaveLength(1)
    expect(
      JSON.parse(scripts[0]!.replace(/^<script[^>]*>|<\/script>$/g, ''))[2].mainEntity[0].name,
    ).toBe('</script><script>alert(1)</script>')
  })

  it('writes absolute canonical and hreflang only when the origin is known', () => {
    const withOrigin = renderGuideDocument(guideEn, options)
    expect(withOrigin).toContain('<link rel="canonical" href="https://example.com/guide/en/" />')
    expect(withOrigin).toContain('hreflang="zh-CN" href="https://example.com/guide/"')
    expect(withOrigin).not.toContain('noindex')

    const bare = renderGuideDocument(guideEn, { ...options, origin: null, indexing: false })
    expect(bare).not.toContain('rel="canonical"')
    expect(bare).not.toContain('application/ld+json')
    expect(bare).toContain('<meta name="robots" content="noindex, nofollow" />')
  })
})
