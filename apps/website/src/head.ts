import { alternatePage, pageMeta, type SitePage } from './catalog'

const origin = import.meta.env.VITE_PUBLIC_ORIGIN as string
const indexing =
  import.meta.env.VITE_SEARCH_INDEXING !== false && import.meta.env.VITE_SEARCH_INDEXING !== 'false'
export function pageHead(page: SitePage) {
  const meta = pageMeta(page)
  const other = alternatePage(page)
  const canonical = origin ? `${origin}${page.path}` : null
  return {
    meta: [
      { title: meta.title },
      { name: 'description', content: meta.description },
      {
        name: 'robots',
        content: indexing && page.kind !== 'login' ? 'index, follow' : 'noindex, nofollow',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Muvloom' },
      { property: 'og:title', content: meta.title },
      { property: 'og:description', content: meta.description },
      { property: 'og:locale', content: page.locale === 'en' ? 'en_US' : 'zh_CN' },
      { name: 'twitter:card', content: 'summary_large_image' },
      ...(canonical
        ? [
            { property: 'og:url', content: canonical },
            { property: 'og:image', content: `${origin}/og/muvloom-og.jpg` },
            { name: 'twitter:image', content: `${origin}/og/muvloom-og.jpg` },
          ]
        : []),
    ],
    links: canonical
      ? [
          { rel: 'canonical', href: canonical },
          ...[page, other].map((p) => ({
            rel: 'alternate',
            hrefLang: p.locale,
            href: `${origin}${p.path}`,
          })),
          {
            rel: 'alternate',
            hrefLang: 'x-default',
            href: `${origin}${page.locale === 'zh-CN' ? page.path : other.path}`,
          },
        ]
      : [],
  }
}
