import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSearchIndex, renderGuidePage } from '../features/guide/render'
import { homeStructuredData } from './homeMeta'
import { renderLlmsTxt } from './llms'
import { collectSitemapPages, GUIDE_EDITIONS, GUIDE_PAGES, indexablePaths } from './pages'
import { renderSitemap } from './sitemap'

/**
 * 搜索引擎相关的构建产物，全部由构建环境决定：
 * - `PUBLIC_ORIGIN`：站点公开源（Pages 发布脚本按版本传入）。有它才写 canonical、og:url、
 *   hreflang、结构化数据与 sitemap——这些都要求绝对地址，猜错域名比不写更糟。
 *   `llms.txt` 在没有源时改写为站内路径，不猜域名。
 * - `SEARCH_INDEXING=false`：测试站与内部站。robots.txt 整站 Disallow，页面再加 noindex，
 *   不产出 sitemap.xml 与 llms.txt。未设置时按允许收录处理。
 *
 * 使用指南在这里整页渲染成静态 HTML（见 `features/guide/render.ts`），每种语言一个首页加每章
 * 一页，另出一份站内搜索索引；应用首页仍是 SPA，只补 head 里的元信息。
 * 公开页面登记在 `pages.ts`。形状是 Vite 的 Plugin，这里不 import vite 以免把它带进应用的类型图。
 */

const EDITIONS = GUIDE_EDITIONS

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

const searchIndexPath = (content: (typeof EDITIONS)[number]) => `${content.root}search.json`

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

export function homeTags(origin: string | null, indexing: boolean) {
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
      children: JSON.stringify(homeStructuredData(origin)).replace(/</g, '\\u003c'),
    },
  )
  return tags
}

function robots(origin: string | null, indexing: boolean): string {
  if (!indexing) return 'User-agent: *\nDisallow: /\n'
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /p/']
  if (origin) lines.push('', `Sitemap: ${origin}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

export function readLlmsSource(): string {
  return readFileSync(new URL('./llms.txt', import.meta.url), 'utf8')
}

/**
 * robots、sitemap、llms.txt。搜索索引仍由插件按指南内容另发。
 * 测试站不发 llms.txt：这份文件会被当成该主机的产品说明，写上测试域名或借测试主机
 * 指向生产站都是错的。允许收录但没有公开源时仍发出，链接改成站内路径。
 */
export function seoStaticFiles(input: {
  origin: string | null
  indexing: boolean
  updated: string
  llmsSource: string
}): { fileName: string; source: string }[] {
  const files = [{ fileName: 'robots.txt', source: robots(input.origin, input.indexing) }]
  if (input.origin && input.indexing) {
    files.push({
      fileName: 'sitemap.xml',
      source: renderSitemap(input.origin, collectSitemapPages(input.updated)),
    })
  }
  if (input.indexing) {
    files.push({
      fileName: 'llms.txt',
      source: renderLlmsTxt(input.llmsSource, {
        origin: input.origin,
        paths: indexablePaths(),
      }),
    })
  }
  return files
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
      for (const file of seoStaticFiles({
        origin,
        indexing,
        updated,
        llmsSource: readLlmsSource(),
      }))
        this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source })
      for (const content of EDITIONS)
        this.emitFile({
          type: 'asset',
          fileName: searchIndexPath(content).slice(1),
          source: JSON.stringify(buildSearchIndex(content)),
        })
    },
  }
}
