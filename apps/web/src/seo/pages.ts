import { guideEn } from '../features/guide/content/en'
import { guideZhCN } from '../features/guide/content/zh-CN'
import type { GuideContent } from '../features/guide/model'
import { guidePagePath } from '../features/guide/render'

/**
 * 能被搜索引擎收录的公开页面，集中登记在这里。
 *
 * - 工作台路由是 SPA，整站共用一份 `index.html`。`/image` 与 `/` 是同一个创作入口，
 *   sitemap 只列根地址；`llms.txt` 仍可以引用 `/image`。
 * - 使用指南由内容模型推导，加章节不用改这份清单。
 * - 以后的着陆页、`/blog` 等构建期页面只加进 `PRERENDERED_PAGES`：
 *   sitemap 的 hreflang / lastmod，以及 `llms.txt` 里指向它们的链接，都从这里来。
 */

/** 第一份是 x-default。 */
export const GUIDE_EDITIONS: GuideContent[] = [guideZhCN, guideEn]

export interface GuidePageRef {
  content: GuideContent
  chapterId: string | null
}

/** 每个指南页面：站内地址 → 内容。Vite 入口与它一一对应。 */
export const GUIDE_PAGES: Record<string, GuidePageRef> = Object.fromEntries(
  GUIDE_EDITIONS.flatMap((content) =>
    [null, ...content.chapters.map((chapter) => chapter.id)].map((chapterId) => [
      guidePagePath(content, chapterId),
      { content, chapterId },
    ]),
  ),
)

export interface SitemapAlternate {
  hreflang: string
  path: string
}

export interface SitemapPage {
  /** 站内路径，以 `/` 开头。目录页保留结尾的 `/`，与 canonical 一致。 */
  path: string
  /** 知道内容日期时才写，格式 `YYYY-MM-DD`。没有可靠日期就省略。 */
  lastmod?: string
  /** 含本页在内的语言版本。没有独立语言地址时不写。 */
  alternates?: readonly SitemapAlternate[]
  /** `alternates` 存在时的 x-default。 */
  xDefaultPath?: string
}

/** 收进 sitemap 的工作台公开路由。`/image` 不在这里。 */
export const APP_SITEMAP_PATHS = [
  '/',
  '/explore',
  '/assets',
  '/tools',
  '/pricing',
  '/terms',
  '/privacy',
] as const

/** 真实可打开、但与另一条 sitemap 地址是同一份文档的路径。 */
export const SITEMAP_ALIASES = ['/image'] as const

/**
 * 指南以外的构建期页面。着陆页和博客上线时追加一项，例如：
 *
 * `{ path: '/blog/', lastmod: '2026-10-14', alternates: [...], xDefaultPath: '/blog/' }`
 *
 * 指南页面不要抄进这里，它们随内容模型生成。
 */
export const PRERENDERED_PAGES: readonly SitemapPage[] = []

/** 比较链接时忽略结尾斜杠、hash 和 query。根路径保持 `/`。 */
export function canonicalPath(path: string): string {
  const bare = (path.split('#')[0] ?? '').split('?')[0] ?? ''
  if (bare === '' || bare === '/') return '/'
  return bare.replace(/\/+$/, '')
}

export function guideSitemapPages(updated: string): SitemapPage[] {
  return GUIDE_EDITIONS.flatMap((content) =>
    [null, ...content.chapters.map((chapter) => chapter.id)].map((chapterId) => ({
      path: guidePagePath(content, chapterId),
      lastmod: updated,
      alternates: GUIDE_EDITIONS.map((edition) => ({
        hreflang: edition.lang,
        path: guidePagePath(edition, chapterId),
      })),
      xDefaultPath: guidePagePath(GUIDE_EDITIONS[0]!, chapterId),
    })),
  )
}

/** `extra` 只给测试注入尚未写进清单的页面；生产调用不传。 */
export function collectSitemapPages(
  updated: string,
  extra: readonly SitemapPage[] = PRERENDERED_PAGES,
): SitemapPage[] {
  return [...APP_SITEMAP_PATHS.map((path) => ({ path })), ...extra, ...guideSitemapPages(updated)]
}

/** `llms.txt` 可以指向的站内路径：sitemap 页面、别名，以及它们的语言版本。 */
export function indexablePaths(extra: readonly SitemapPage[] = PRERENDERED_PAGES): Set<string> {
  const paths = new Set<string>()
  const add = (path: string) => paths.add(canonicalPath(path))
  for (const path of APP_SITEMAP_PATHS) add(path)
  for (const path of SITEMAP_ALIASES) add(path)
  for (const page of [...extra, ...guideSitemapPages('1970-01-01')]) {
    add(page.path)
    for (const alternate of page.alternates ?? []) add(alternate.path)
    if (page.xDefaultPath) add(page.xDefaultPath)
  }
  return paths
}
