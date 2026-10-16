import type { Block, GuideContent } from '../../web/src/features/guide/model'
import { editions, pageMeta, type SitePage } from './catalog'

export const plainInline = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|\[\[|\]\]|\{\{|\}\}|`/g, '')
function blockText(block: Block): string {
  if ('text' in block) return plainInline(block.text)
  if ('items' in block) return block.items.map(plainInline).join(' ')
  if (block.type === 'table')
    return [...block.head, ...block.rows.flat()].map(plainInline).join(' ')
  return [block.alt, block.caption ?? ''].join(' ')
}
export function searchGuide(guide: GuideContent, query: string) {
  const items = guide.chapters.flatMap((chapter) => [
    { title: chapter.title, path: `${guide.root}${chapter.id}/`, text: chapter.summary },
    ...chapter.subsections.map((section) => ({
      title: `${chapter.title} · ${section.title}`,
      path: `${guide.root}${chapter.id}/#${section.id}`,
      text: section.blocks.map(blockText).join(' '),
    })),
    ...(chapter.faq ?? []).map((item) => ({
      title: item.q,
      path: `${guide.root}${chapter.id}/#faq`,
      text: item.a,
    })),
  ])
  items.push(
    ...guide.faq.items.map((item) => ({
      title: item.q,
      path: `${guide.root}#${guide.faq.id}`,
      text: item.a,
    })),
  )
  const needle = query.trim().toLocaleLowerCase()
  return needle
    ? items.filter((item) => `${item.title} ${item.text}`.toLocaleLowerCase().includes(needle))
    : []
}
export function structuredData(page: SitePage, origin: string): Record<string, unknown>[] {
  if (!origin || page.kind === 'login') return []
  const meta = pageMeta(page)
  const base = {
    '@context': 'https://schema.org',
    '@type': page.kind === 'home' ? 'WebSite' : 'WebPage',
    name: meta.title,
    description: meta.description,
    url: origin + page.path,
    inLanguage: page.locale,
    isPartOf: { '@type': 'WebSite', name: 'Muvloom', url: `${origin}/` },
  }
  if (page.kind !== 'guide') return [base]
  const guide = editions[page.locale],
    chapter = guide.chapters.find((item) => item.id === page.chapterId)
  const crumbs = [
    { name: guide.chrome.brand, item: origin + (page.locale === 'en' ? '/en/' : '/') },
    { name: guide.chrome.title, item: origin + guide.root },
    ...(chapter ? [{ name: chapter.title, item: origin + page.path }] : []),
  ]
  const faq = chapter ? (chapter.faq ?? []) : guide.faq.items
  const procedures =
    chapter?.subsections.flatMap((section) => {
      const steps = section.blocks.flatMap((block, index) => {
        const previous = section.blocks[index - 1]
        return block.type === 'steps' && !(previous?.type === 'shot' && previous.marks?.length)
          ? block.items.map(plainInline)
          : []
      })
      return steps.length
        ? [
            {
              '@context': 'https://schema.org',
              '@type': 'HowTo',
              name: section.title,
              inLanguage: page.locale,
              url: `${origin}${page.path}#${section.id}`,
              step: steps.map((text, index) => ({
                '@type': 'HowToStep',
                position: index + 1,
                text,
              })),
            },
          ]
        : []
    }) ?? []
  return [
    {
      ...base,
      '@type': chapter ? 'TechArticle' : 'WebPage',
      ...(chapter ? { headline: meta.title } : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        ...item,
      })),
    },
    ...(faq.length
      ? [
          {
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            inLanguage: page.locale,
            mainEntity: faq.map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: { '@type': 'Answer', text: item.a },
            })),
          },
        ]
      : []),
    ...procedures,
  ]
}
