import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderLlmsTxt } from '../../seo/llms'
import { collectSitemapPages, indexablePaths, type SitemapPage } from '../../seo/pages'
import { renderSitemap } from '../../seo/sitemap'
import { homeTags, seoStaticFiles } from '../../seo/vitePlugin'

const SOURCE = readFileSync(resolve(__dirname, '../../seo/llms.txt'), 'utf8')
const UPDATED = '2026-10-14'

const PUBLISHED = `# 幕芽 Muvloom

> 幕芽 Muvloom 是面向电商卖家和内容创作者的中文 AI 图片与视频创作工作台。上传商品图或贴一个亚马逊商品链接，智能体会抓取商品图、制定批量方案，再出整套主图、详情图、白底图、模特图和种草视频。所有结果都铺在同一张无限画布上，可以框选局部继续修改。平台支持多个图片和视频模型，入门套餐 ¥39/月起。

## 关键事实
- 产品名：幕芽 Muvloom（官网 https://muvloom.online/ ，创作入口 https://muvloom.online/image ，未登录可打开）
- 适合谁：淘宝、天猫、拼多多、抖店、小红书、亚马逊等平台的中小卖家（这里列的是卖家开店的平台，不代表支持抓取这些平台的链接）和电商运营；需要商品图和种草素材的内容创作者
- 三种创作模式：智能创作（与智能体对话）、快速生成、画布创作（无限画布）
- 核心能力：抓取商品链接里的商品图（目前只支持亚马逊商品页，网址含 /dp/ 或 /gp/product/；淘宝、天猫、京东、拼多多、1688 待开放；其他平台的商品可以上传图片）；批量规划后生成产品套图；电商主图、场景替换、商品换款、海报营销物料、爆款图片复刻、反推提示词、图片本地化；局部重绘（框选修改）；图生视频、电商主图视频、种草视频、分镜和时间线
- 工具箱：缩放、压缩、格式转换（JPG/PNG/WebP/AVIF）、裁剪（含店铺和社媒尺寸）、旋转翻转、拼图、长图拼接、切图
- 积分规则：图片按张计费，视频按秒计费，智能体按每 1K tokens 计费；订阅积分每月发放，到期清零；充值积分永久有效；任务失败或取消会退回积分

## 主要页面
- [开始创作 /image](https://muvloom.online/image)：创作主页，含智能创作、快速生成、画布创作
- [价格与积分](https://muvloom.online/pricing)：套餐、积分、退还规则
- [使用指南](https://muvloom.online/guide/)：功能和智能体技能说明（[English](https://muvloom.online/guide/en/)）
`

describe('llms.txt', () => {
  it('drops unresolved placeholder sentences and links to pages that are not published', () => {
    expect(SOURCE).toContain('{{¥39套餐积分}}')
    const text = renderLlmsTxt(SOURCE, {
      origin: 'https://muvloom.online',
      paths: indexablePaths(),
    })
    expect(text).toBe(PUBLISHED)
    expect(text).not.toMatch(/\{\{/)
    expect(text).toContain('目前只支持亚马逊商品页，网址含 /dp/ 或 /gp/product/')
    expect(text).toContain('不代表支持抓取这些平台的链接')
    expect(text).not.toContain('link-to-suite')
    expect(text).not.toContain('ai-product-photo')
    expect(text).not.toContain('white-background/')
    expect(text).not.toContain('ai-model-photo')
    expect(text).not.toContain('/facts/')
    expect(text).not.toContain('/models/')
    expect(text).not.toContain('邀请奖励')
    expect(text).not.toContain('GPT Image 2.5')
  })

  it('rewrites absolute URLs to PUBLIC_ORIGIN and falls back to site paths without one', () => {
    const withOrigin = renderLlmsTxt(SOURCE, {
      origin: 'https://example.com',
      paths: indexablePaths(),
    })
    expect(withOrigin).toContain('https://example.com/image')
    expect(withOrigin).toContain('https://example.com/guide/en/')
    expect(withOrigin).not.toContain('muvloom.online')

    const relative = renderLlmsTxt(SOURCE, { origin: null, paths: indexablePaths() })
    expect(relative).toContain('官网 / ，创作入口 /image')
    expect(relative).toContain('](/guide/)')
    expect(relative).not.toContain('https://')
  })

  it('keeps a source link once that page is registered', () => {
    const source =
      '- [商品链接一键出套图](https://muvloom.online/link-to-suite/)：贴亚马逊商品链接或上传商品图\n'
    expect(renderLlmsTxt(source, { origin: 'https://example.com', paths: indexablePaths() })).toBe(
      '\n',
    )
    const landing: SitemapPage = { path: '/link-to-suite/' }
    expect(
      renderLlmsTxt(source, {
        origin: 'https://example.com',
        paths: indexablePaths([landing]),
      }),
    ).toBe(
      '- [商品链接一键出套图](https://example.com/link-to-suite/)：贴亚马逊商品链接或上传商品图\n',
    )
  })
})

describe('sitemap', () => {
  const xml = renderSitemap('https://example.com', collectSitemapPages(UPDATED))

  function block(path: string): string {
    const loc = `https://example.com${path}`
    const match = xml.match(new RegExp(`<url><loc>${loc}</loc>[\\s\\S]*?</url>`))
    expect(match, path).not.toBeNull()
    return match![0]
  }

  it('lists public app routes and guide pages, with hreflang and lastmod only where they exist', () => {
    for (const path of ['/', '/explore', '/assets', '/tools', '/pricing', '/terms', '/privacy']) {
      const entry = block(path)
      expect(entry).not.toContain('lastmod')
      expect(entry).not.toContain('xhtml:link')
    }
    expect(xml).not.toContain('https://example.com/image')
    expect(xml).not.toContain('/link-to-suite/')
    expect(xml).not.toContain('/blog')
    expect(xml).not.toContain('/projects')

    const guide = block('/guide/getting-started/')
    expect(guide).toContain(`<lastmod>${UPDATED}</lastmod>`)
    expect(guide).toContain('hreflang="zh-CN" href="https://example.com/guide/getting-started/"')
    expect(guide).toContain('hreflang="en" href="https://example.com/guide/en/getting-started/"')
    expect(guide).toContain(
      'hreflang="x-default" href="https://example.com/guide/getting-started/"',
    )
    expect(block('/guide/')).toContain('hreflang="en" href="https://example.com/guide/en/"')
    expect(block('/guide/en/canvas/')).toContain(
      'hreflang="zh-CN" href="https://example.com/guide/canvas/"',
    )
  })

  it('picks up a future prerendered page from the registry argument', () => {
    const blog: SitemapPage = {
      path: '/blog/',
      lastmod: '2026-10-01',
      alternates: [
        { hreflang: 'zh-CN', path: '/blog/' },
        { hreflang: 'en', path: '/blog/en/' },
      ],
      xDefaultPath: '/blog/',
    }
    const withBlog = renderSitemap('https://example.com', collectSitemapPages(UPDATED, [blog]))
    expect(withBlog).toContain(
      '<url><loc>https://example.com/blog/</loc><lastmod>2026-10-01</lastmod><xhtml:link rel="alternate" hreflang="zh-CN" href="https://example.com/blog/"/><xhtml:link rel="alternate" hreflang="en" href="https://example.com/blog/en/"/><xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/blog/"/></url>',
    )
  })
})

describe('seo static files', () => {
  it('omits the sitemap and llms.txt when the site must not be indexed', () => {
    const files = seoStaticFiles({
      origin: 'https://test.muvloom.online',
      indexing: false,
      updated: UPDATED,
      llmsSource: SOURCE,
    })
    expect(files.map((file) => file.fileName)).toEqual(['robots.txt'])
    expect(files[0]?.source).toBe('User-agent: *\nDisallow: /\n')
  })

  it('emits llms.txt without a sitemap when indexing is allowed but the origin is unknown', () => {
    const files = seoStaticFiles({
      origin: null,
      indexing: true,
      updated: UPDATED,
      llmsSource: SOURCE,
    })
    expect(files.map((file) => file.fileName)).toEqual(['robots.txt', 'llms.txt'])
    expect(files[0]?.source).not.toContain('Sitemap:')
    expect(files[1]?.source).not.toContain('https://')
  })

  it('emits robots, sitemap and llms.txt for the public site', () => {
    const files = seoStaticFiles({
      origin: 'https://muvloom.online',
      indexing: true,
      updated: UPDATED,
      llmsSource: SOURCE,
    })
    expect(files.map((file) => file.fileName)).toEqual(['robots.txt', 'sitemap.xml', 'llms.txt'])
    expect(files[0]?.source).toContain('Sitemap: https://muvloom.online/sitemap.xml')
    expect(files[1]?.source).toContain('<loc>https://muvloom.online/guide/</loc>')
    expect(files[2]?.source).toBe(PUBLISHED)
  })
})

describe('home structured data', () => {
  it('publishes Organization, WebSite and WebApplication and nothing the page does not show', () => {
    const tags = homeTags('https://muvloom.online', true)
    const script = tags.find((tag) => tag.attrs?.type === 'application/ld+json')
    const data = JSON.parse(script?.children ?? '') as {
      '@graph': { '@type': string; '@id'?: string; description?: string }[]
    }
    expect(data['@graph'].map((node) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      'WebApplication',
    ])
    expect(data['@graph'].map((node) => node['@id'])).toEqual([
      'https://muvloom.online/#organization',
      'https://muvloom.online/#website',
      'https://muvloom.online/#app',
    ])
    expect(data['@graph'][2]?.description).toBe(
      '一句话生成图片，在无限画布上继续编辑，与 AI 智能体一起完成海报、商品图与短视频。',
    )
    expect(JSON.stringify(data)).not.toContain('FAQPage')
    expect(JSON.stringify(data)).not.toContain('Offer')
    expect(JSON.stringify(data)).not.toMatch(/\{\{/)

    expect(homeTags(null, false).map((tag) => tag.attrs?.content)).toEqual(['noindex, nofollow'])
    expect(homeTags(null, true)).toEqual([])
  })
})
