import {
  type Block,
  type GuideContent,
  type GuidePage,
  guideEntries,
  pageBlocks,
} from '../../web/src/features/guide/model'
import { editions, pageMeta, type SitePage } from './catalog'

export const plainInline = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|\[\[|\]\]|\{\{|\}\}|`/g, '')
function blockText(block: Block): string {
  switch (block.type) {
    case 'p':
    case 'callout':
      return plainInline(block.text)
    case 'steps':
    case 'list':
      return block.items.map(plainInline).join(' ')
    case 'table':
      return [...block.head, ...block.rows.flat()].map(plainInline).join(' ')
    case 'faq':
      return block.items.map((item) => `${item.q} ${item.a}`).join(' ')
    case 'prompt':
      return `${plainInline(block.label)} ${block.text}`
    default:
      return [block.alt, block.caption ?? ''].map(plainInline).join(' ')
  }
}
/** 正文字数折算的阅读分钟数：中文按每分钟 400 字，英文按每分钟 200 词，至少 1 分钟。 */
export function readingMinutes(guide: GuideContent, page: GuidePage) {
  const text = [page.summary, ...pageBlocks(page).map(blockText)].join(' ')
  const units =
    guide.lang === 'en' ? text.split(/\s+/).filter(Boolean).length / 200 : text.length / 400
  return Math.max(1, Math.round(units))
}
export function searchGuide(guide: GuideContent, query: string) {
  const items = guideEntries(guide).flatMap(({ page, group, path }) => [
    { title: page.title, path, text: `${group.title} ${page.summary}` },
    ...page.sections.map((section) => ({
      title: `${page.title} · ${section.title}`,
      path: `${path}#${section.id}`,
      text: section.blocks
        .flatMap((block) => (block.type === 'steps' && block.shot ? [block, block.shot] : [block]))
        .map(blockText)
        .join(' '),
    })),
    ...page.sections.flatMap((section) =>
      section.blocks.flatMap((block) =>
        block.type === 'faq'
          ? block.items.map((item) => ({
              title: item.q,
              path: `${path}#${section.id}`,
              text: item.a,
            }))
          : [],
      ),
    ),
  ])
  const needle = query.trim().toLocaleLowerCase()
  return needle
    ? items.filter((item) => `${item.title} ${item.text}`.toLocaleLowerCase().includes(needle))
    : []
}
export function structuredData(page: SitePage, origin: string): Record<string, unknown>[] {
  if (!origin || page.kind === 'login' || page.kind === 'moved') return []
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
    entry = guideEntries(guide).find((item) => item.key === page.guideKey)
  const crumbs = [
    { name: guide.chrome.brand, item: origin + (page.locale === 'en' ? '/en/' : '/') },
    { name: guide.chrome.title, item: origin + guide.root },
    ...(entry
      ? [
          {
            name: entry.group.title,
            item: origin + guideEntries(guide).find((item) => item.group === entry.group)!.path,
          },
          { name: entry.page.title, item: origin + page.path },
        ]
      : []),
  ]
  const sections = entry?.page.sections ?? []
  const faq = sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.type === 'faq' ? block.items : [])),
  )
  const procedures = sections.flatMap((section) => {
    const steps = section.blocks.flatMap((block) =>
      block.type === 'steps' ? block.items.map(plainInline) : [],
    )
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
  })
  return [
    {
      ...base,
      '@type': entry ? 'TechArticle' : 'WebPage',
      ...(entry ? { headline: meta.title, dateModified: entry.page.updated } : {}),
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
