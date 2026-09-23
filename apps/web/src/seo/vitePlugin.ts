import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guideEn } from '../features/guide/content/en'
import { guideZhCN } from '../features/guide/content/zh-CN'
import type { GuideContent } from '../features/guide/model'
import {
  buildSearchIndex,
  escapeHtml,
  guidePagePath,
  renderGuidePage,
} from '../features/guide/render'

/**
 * 搜索引擎相关的构建产物，全部由构建环境决定：
 * - `PUBLIC_ORIGIN`：站点公开源（Pages 发布脚本按版本传入）。有它才写 canonical、og:url、
 *   hreflang、结构化数据与 sitemap——这些都要求绝对地址，猜错域名比不写更糟。
 * - `SEARCH_INDEXING=false`：测试站与内部站。robots.txt 整站 Disallow，页面再加 noindex。
 *   未设置时按允许收录处理，自托管的默认行为与普通网站一致。
 *
 * 使用指南在这里整页渲染成静态 HTML（见 `features/guide/render.ts`），每种语言一个首页加每章
 * 一页，另出一份站内搜索索引；应用首页仍是 SPA，只补 head 里的元信息。
 * 形状是 Vite 的 Plugin，这里不 import vite 以免把它带进应用的类型图。
 */

/** 第一份是 x-default。 */
const EDITIONS: GuideContent[] = [guideZhCN, guideEn]

interface GuidePageRef {
  content: GuideContent
  chapterId: string | null
}

/** 每个指南页面：站内地址 → 内容。Vite 入口 `apps/web<path>index.html` 与它一一对应。 */
const GUIDE_PAGES: Record<string, GuidePageRef> = Object.fromEntries(
  EDITIONS.flatMap((content) =>
    [null, ...content.chapters.map((chapter) => chapter.id)].map((chapterId) => [
      guidePagePath(content, chapterId),
      { content, chapterId },
    ]),
  ),
)

/**
 * Vite 的 HTML 入口：每页一个占位文件（`apps/web/guide/**\/index.html`），内容在 transform 时整页替换。
 * 加章节要补两种语言的占位文件，漏了构建会报 "Could not resolve entry module"。
 */
export function guideHtmlEntries(webRoot: string): Record<string, string> {
  return Object.fromEntries(
    Object.keys(GUIDE_PAGES).map((path) => [
      `guide${path.replace(/^\/guide/, '').replace(/\/+/g, '-')}`.replace(/-$/, ''),
      join(webRoot, path, 'index.html'),
    ]),
  )
}

const searchIndexPath = (content: GuideContent) => `${content.root}search.json`

/** 收进 sitemap 的应用公开页面。`/image` 与 `/` 是同一个入口，只列根地址。 */
const SITEMAP_PATHS = ['/', '/explore']

interface EmitContext {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string
}

interface DevServer {
  middlewares: {
    use(
      handler: (
        req: { url?: string },
        res: { setHeader(name: string, value: string): void; end(body: string): void },
        next: () => void,
      ) => void,
    ): void
  }
}

/** 截图只收 WebP：读 RIFF 头里的画布尺寸（VP8X / VP8 / VP8L 三种编码各有写法）。 */
function webpSize(file: string): { width: number; height: number } {
  const data = readFileSync(file)
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')
    throw new Error(`guide: ${file} is not a WebP image`)
  const chunk = data.toString('ascii', 12, 16)
  if (chunk === 'VP8X')
    return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) }
  if (chunk === 'VP8 ')
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  throw new Error(`guide: ${file} has an unknown WebP chunk ${chunk}`)
}

function readOrigin(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, '')
  if (!value) return null
  const url = new URL(value)
  if (url.origin !== value) throw new Error(`PUBLIC_ORIGIN must be a bare origin, got ${raw}`)
  return value
}

function homeTags(origin: string | null, indexing: boolean) {
  const tags: { tag: string; attrs?: Record<string, string>; children?: string }[] = []
  if (!indexing) tags.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } })
  if (!origin) return tags
  const url = `${origin}/`
  const image = `${origin}/og/muvloom-og.jpg`
  tags.push(
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
    { tag: 'meta', attrs: { property: 'og:url', content: url } },
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } },
    {
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      children: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: '幕芽 Muvloom',
        alternateName: 'Muvloom',
        url,
        applicationCategory: 'DesignApplication',
        operatingSystem: 'Web',
        description:
          '幕芽 Muvloom，AI 图片与视频创作工作台：一句话生成图片，在无限画布上继续编辑，与 AI 智能体一起完成创作。',
        image,
        inLanguage: ['zh-CN', 'en'],
      }).replace(/</g, '\\u003c'),
    },
  )
  return tags
}

function sitemap(origin: string): string {
  const guidePages = Object.values(GUIDE_PAGES).map(({ content, chapterId }) => {
    const alternates = EDITIONS.map(
      (edition) =>
        `<xhtml:link rel="alternate" hreflang="${edition.lang}" href="${escapeHtml(origin + guidePagePath(edition, chapterId))}"/>`,
    ).join('')
    return `<url><loc>${escapeHtml(origin + guidePagePath(content, chapterId))}</loc>${alternates}</url>`
  })
  const pages = [
    ...SITEMAP_PATHS.map((path) => `<url><loc>${escapeHtml(origin + path)}</loc></url>`),
    ...guidePages,
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.join('\n')}
</urlset>
`
}

function robots(origin: string | null, indexing: boolean): string {
  if (!indexing) return 'User-agent: *\nDisallow: /\n'
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /local-compat', 'Disallow: /p/']
  if (origin) lines.push('', `Sitemap: ${origin}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

export function seoPlugin({ publicDir }: { publicDir: string }) {
  const origin = readOrigin(process.env.PUBLIC_ORIGIN)
  const indexing = process.env.SEARCH_INDEXING !== 'false'
  const updated = new Date().toISOString().slice(0, 10)
  return {
    name: 'seo',
    transformIndexHtml: {
      // 指南整页替换，必须赶在 Vite 解析脚本与样式之前。
      order: 'pre' as const,
      handler(html: string, ctx: { path: string }) {
        if (ctx.path.startsWith('/guide/')) {
          const page = GUIDE_PAGES[ctx.path.replace(/index\.html$/, '')]
          if (!page)
            throw new Error(`guide: ${ctx.path} has no content; remove the entry or add a chapter`)
          return renderGuidePage(page.content, page.chapterId, {
            origin,
            indexing,
            editions: EDITIONS,
            updated,
            imageSize: (src) => webpSize(join(publicDir, src)),
          })
        }
        if (ctx.path === '/index.html') return { html, tags: homeTags(origin, indexing) }
        return html
      },
    },
    configureServer(server: DevServer) {
      server.middlewares.use((req, res, next) => {
        const content = EDITIONS.find((edition) => req.url === searchIndexPath(edition))
        if (!content) return next()
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(buildSearchIndex(content)))
      })
    },
    generateBundle(this: EmitContext) {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots(origin, indexing) })
      if (origin && indexing)
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap(origin) })
      for (const content of EDITIONS)
        this.emitFile({
          type: 'asset',
          fileName: searchIndexPath(content).slice(1),
          source: JSON.stringify(buildSearchIndex(content)),
        })
    },
  }
}
