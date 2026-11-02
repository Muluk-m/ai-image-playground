import { counterpartPage, pageMeta, type SitePage } from './catalog'

const origin = import.meta.env.VITE_PUBLIC_ORIGIN as string
const indexing =
  import.meta.env.VITE_SEARCH_INDEXING !== false && import.meta.env.VITE_SEARCH_INDEXING !== 'false'
export function pageHead(page: SitePage) {
  const meta = pageMeta(page)
  const other = counterpartPage(page)
  // 跳转页不收录，canonical 指向新地址；没有 JavaScript 时由 refresh 带过去。
  const canonical = origin ? `${origin}${page.movedTo ?? page.path}` : null
  const indexable = indexing && page.kind !== 'login' && page.kind !== 'moved'
  return {
    meta: [
      { title: meta.title },
      { name: 'description', content: meta.description },
      {
        name: 'robots',
        content: indexable ? 'index, follow' : 'noindex, nofollow',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Muvloom' },
      { property: 'og:title', content: meta.title },
      { property: 'og:description', content: meta.description },
      { property: 'og:locale', content: page.locale === 'en' ? 'en_US' : 'zh_CN' },
      { name: 'twitter:card', content: 'summary_large_image' },
      ...(page.movedTo ? [{ httpEquiv: 'refresh', content: `1; url=${page.movedTo}` }] : []),
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
          ...(other && page.kind !== 'moved'
            ? [
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
            : []),
        ]
      : [],
  }
}
