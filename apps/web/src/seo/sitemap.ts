import { escapeHtml } from '../features/guide/render'
import type { SitemapPage } from './pages'

/** 绝对地址的 sitemap。没有 hreflang 的页面不写 xhtml 链接；没有可靠日期的页面不写 lastmod。 */
export function renderSitemap(origin: string, pages: readonly SitemapPage[]): string {
  const urls = pages.map((page) => {
    const loc = `<loc>${escapeHtml(origin + page.path)}</loc>`
    const lastmod = page.lastmod ? `<lastmod>${escapeHtml(page.lastmod)}</lastmod>` : ''
    const alternates = (page.alternates ?? [])
      .map(
        (alternate) =>
          `<xhtml:link rel="alternate" hreflang="${escapeHtml(alternate.hreflang)}" href="${escapeHtml(origin + alternate.path)}"/>`,
      )
      .join('')
    const xDefault = page.xDefaultPath
      ? `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeHtml(origin + page.xDefaultPath)}"/>`
      : ''
    return `<url>${loc}${lastmod}${alternates}${xDefault}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`
}
