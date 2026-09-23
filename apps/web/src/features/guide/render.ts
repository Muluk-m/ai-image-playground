import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  ChevronDown,
  CircleHelp,
  Copy,
  FolderOpen,
  Frame,
  Info,
  Lightbulb,
  Rocket,
  Search,
  Sparkles,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Block, GuideChapter, GuideContent, Inline } from './model'

/**
 * 构建期把 `GuideContent` 渲染成完整的 HTML 文档：一个首页加每章一页。正文、标题层级与
 * 结构化数据都在 HTML 里，搜索引擎不必执行脚本；浏览器端的 `client.ts` 只负责目录高亮、
 * 站内搜索与复制按钮。
 *
 * 类名必须整串写在本文件里，Tailwind 才扫得到。
 */

export interface GuideRenderOptions {
  /** 站点的公开源（`https://muvloom.online`）。缺席时不写绝对地址：canonical、og:url、hreflang 都省掉。 */
  origin: string | null
  /** false 时加 `noindex`：测试站与内部站不该出现在搜索结果里。 */
  indexing: boolean
  /** 全部语言版本，同一页面按章节 id 互指 hreflang；第一份作 x-default。 */
  editions: GuideContent[]
  /** 截图的像素尺寸，写进 width/height 免得图片加载时页面跳动。 */
  imageSize: (src: string) => { width: number; height: number }
  /** 构建日期，`YYYY-MM-DD`。 */
  updated: string
}

/** 指南页面的站内地址：`chapterId` 为 null 时是首页。 */
export function guidePagePath(content: GuideContent, chapterId: string | null): string {
  return chapterId ? `${content.root}${chapterId}/` : content.root
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

function safeHref(href: string): string {
  if (/^(\/(?!\/)|#|https:\/\/)/.test(href)) return href
  throw new Error(`guide: link must be a site path, #anchor or https URL, got ${href}`)
}

export function renderInline(text: Inline): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>')
    .replace(
      /\[\[(.+?)\]\]/g,
      '<span class="mx-0.5 inline-flex items-center whitespace-nowrap rounded-md border border-border bg-muted/60 px-1.5 align-baseline text-[0.88em] font-medium leading-[1.6] text-foreground">$1</span>',
    )
    .replace(
      /\{\{(.+?)\}\}/g,
      '<kbd class="mx-0.5 inline-flex min-w-[1.7em] items-center justify-center rounded-[5px] border border-border border-b-2 bg-background px-1.5 font-mono text-[0.78em] leading-[1.7] text-foreground">$1</kbd>',
    )
    .replace(
      /`([^`]+)`/g,
      '<code class="rounded-[5px] bg-muted px-1.5 py-px font-mono text-[0.86em] text-foreground">$1</code>',
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label: string, href: string) =>
        `<a class="font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary" href="${safeHref(href)}">${label}</a>`,
    )
}

/** 去掉行内标记，只留文字：搜索索引与结构化数据用。 */
export function plainInline(text: Inline): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\{\{(.+?)\}\}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
}

type LucideIcon = typeof Sparkles

const icon = (Icon: LucideIcon, className: string) =>
  renderToStaticMarkup(createElement(Icon, { className, strokeWidth: 1.75, 'aria-hidden': true }))

const CHAPTER_ICONS: Record<string, LucideIcon> = {
  'getting-started': Rocket,
  create: WandSparkles,
  canvas: Frame,
  agent: Bot,
  assets: FolderOpen,
}

function chapterIcon(chapter: GuideChapter, className: string): string {
  const Icon = CHAPTER_ICONS[chapter.id]
  if (!Icon) throw new Error(`guide: no icon for chapter ${chapter.id}`)
  return icon(Icon, className)
}

const two = (index: number) => String(index + 1).padStart(2, '0')

const CALLOUT = {
  tip: { Icon: Lightbulb, bar: 'border-l-primary', tint: 'text-primary' },
  note: { Icon: Info, bar: 'border-l-foreground/25', tint: 'text-muted-foreground' },
  warn: { Icon: TriangleAlert, bar: 'border-l-warning', tint: 'text-warning' },
} as const

const PROSE = 'text-[15.5px] leading-[1.85] text-foreground/75'

function renderBlock(block: Block, content: GuideContent, options: GuideRenderOptions): string {
  switch (block.type) {
    case 'p':
      return `<p class="my-5 ${PROSE}">${renderInline(block.text)}</p>`
    case 'list':
      return `<ul class="my-5 space-y-2.5">${block.items
        .map(
          (item) =>
            `<li class="relative pl-5 ${PROSE} before:absolute before:left-0.5 before:top-[0.8em] before:h-[5px] before:w-[5px] before:rounded-full before:bg-foreground/35">${renderInline(item)}</li>`,
        )
        .join('')}</ul>`
    case 'steps':
      return `<ol class="my-6">${block.items
        .map(
          (item, index) =>
            `<li class="relative pb-5 pl-11 last:pb-0"><span class="absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full border border-border bg-background font-mono text-[12px] font-medium text-foreground/80">${index + 1}</span>${
              index < block.items.length - 1
                ? '<span aria-hidden="true" class="absolute bottom-0 left-[13.5px] top-8 w-px bg-border"></span>'
                : ''
            }<div class="pt-0.5 ${PROSE}">${renderInline(item)}</div></li>`,
        )
        .join('')}</ol>`
    case 'callout': {
      const style = CALLOUT[block.tone]
      const label =
        content.chrome[
          block.tone === 'tip' ? 'tipLabel' : block.tone === 'warn' ? 'warnLabel' : 'noteLabel'
        ]
      return `<aside class="my-6 flex gap-3 rounded-r-lg border-l-2 ${style.bar} bg-muted/50 px-4 py-3.5">${icon(style.Icon, `mt-[5px] h-4 w-4 shrink-0 ${style.tint}`)}<p class="text-[14.5px] leading-7 text-foreground/75"><span class="font-semibold text-foreground">${escapeHtml(label)}</span><span aria-hidden="true" class="mx-2 text-border">|</span>${renderInline(block.text)}</p></aside>`
    }
    case 'shot': {
      const { width, height } = options.imageSize(block.src)
      const marks = (block.marks ?? [])
        .map(
          (mark, index) =>
            `<span aria-hidden="true" class="absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary font-mono text-[11px] font-bold text-primary-foreground ring-[3px] ring-background" style="left:${mark.x}%;top:${mark.y}%">${index + 1}</span>`,
        )
        .join('')
      const caption = block.caption
        ? `<figcaption class="mt-3 text-center text-[13px] text-muted-foreground">${renderInline(block.caption)}</figcaption>`
        : ''
      return `<figure class="my-8"><a href="${escapeHtml(block.src)}" target="_blank" rel="noopener" class="block rounded-xl border border-border bg-muted/40 p-1.5 transition-colors hover:border-foreground/20"><span class="relative block overflow-hidden rounded-lg"><img class="block h-auto w-full" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" width="${width}" height="${height}" loading="lazy" decoding="async" />${marks}</span></a>${caption}</figure>`
    }
    case 'table':
      return `<div class="my-6 overflow-x-auto"><table class="w-full border-collapse text-left"><thead class="border-b border-foreground/15"><tr>${block.head
        .map(
          (cell) =>
            `<th class="whitespace-nowrap py-2.5 pr-6 text-[12.5px] font-medium text-muted-foreground">${renderInline(cell)}</th>`,
        )
        .join('')}</tr></thead><tbody>${block.rows
        .map(
          (row) =>
            `<tr class="border-b border-border/70">${row
              .map(
                (cell) =>
                  `<td class="py-3 pr-6 align-top text-[14.5px] leading-7 text-foreground/75">${renderInline(cell)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`
    case 'prompt':
      return `<figure class="my-6 overflow-hidden rounded-xl border border-border"><figcaption class="flex items-center justify-between border-b border-border bg-muted/50 py-1.5 pl-4 pr-1.5 text-[12px] font-medium text-muted-foreground">${renderInline(block.label)}<button type="button" data-copy data-copied="${escapeHtml(content.chrome.copied)}" class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-background hover:text-foreground">${icon(Copy, 'h-3.5 w-3.5')}<span>${escapeHtml(content.chrome.copy)}</span></button></figcaption><blockquote class="px-4 py-3.5 text-[14.5px] leading-7 text-foreground/85">${escapeHtml(block.text)}</blockquote></figure>`
  }
}

function renderBlocks(blocks: Block[], content: GuideContent, options: GuideRenderOptions): string {
  return blocks.map((block) => renderBlock(block, content, options)).join('')
}

/* ─────────────────────────────── head ─────────────────────────────── */

function absolute(origin: string, path: string): string {
  return new URL(path, origin).toString()
}

/** JSON 里的 `</script>` 会提前关掉标签；`<` 统一转义。 */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function structuredData(
  content: GuideContent,
  chapter: GuideChapter | null,
  options: GuideRenderOptions,
  origin: string,
) {
  const url = absolute(origin, guidePagePath(content, chapter?.id ?? null))
  const home = absolute(origin, content.root)
  const publisher = {
    '@type': 'Organization',
    name: content.chrome.brand,
    url: absolute(origin, '/'),
    logo: absolute(origin, '/brand/apple-touch-icon.png'),
  }
  const crumbs = [
    { '@type': 'ListItem', position: 1, name: content.chrome.brand, item: absolute(origin, '/') },
    { '@type': 'ListItem', position: 2, name: content.chrome.title, item: home },
  ]
  if (!chapter)
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: content.meta.title,
        description: content.meta.description,
        inLanguage: content.lang,
        url,
        dateModified: options.updated,
        publisher,
        hasPart: content.chapters.map((c) => ({
          '@type': 'TechArticle',
          headline: c.title,
          url: absolute(origin, guidePagePath(content, c.id)),
        })),
      },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        inLanguage: content.lang,
        mainEntity: content.faq.items.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ]
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: chapter.meta.title,
      description: chapter.meta.description,
      inLanguage: content.lang,
      url,
      mainEntityOfPage: url,
      image: absolute(origin, '/og/muvloom-og.jpg'),
      dateModified: options.updated,
      author: publisher,
      publisher,
      isPartOf: { '@type': 'WebPage', name: content.chrome.title, url: home },
      about: { '@type': 'WebApplication', name: content.chrome.brand, url: absolute(origin, '/') },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        ...crumbs,
        { '@type': 'ListItem', position: 3, name: chapter.title, item: url },
      ],
    },
    ...(chapter.faq
      ? [
          {
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            inLanguage: content.lang,
            mainEntity: chapter.faq.map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: { '@type': 'Answer', text: item.a },
            })),
          },
        ]
      : []),
  ]
}

function renderHead(
  content: GuideContent,
  chapter: GuideChapter | null,
  options: GuideRenderOptions,
): string {
  const meta = chapter ? chapter.meta : content.meta
  const tags = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    '<link rel="icon" href="/brand/muvloom-icon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />',
    `<meta property="og:type" content="${chapter ? 'article' : 'website'}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:locale" content="${content.lang === 'en' ? 'en_US' : 'zh_CN'}" />`,
    `<meta property="og:site_name" content="${escapeHtml(content.chrome.brand)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
  ]
  if (!chapter)
    tags.push(
      `<link rel="preload" as="image" href="${escapeHtml(content.home.image)}" fetchpriority="high" />`,
    )
  if (!options.indexing) tags.push('<meta name="robots" content="noindex, nofollow" />')
  if (options.origin) {
    const origin = options.origin
    const url = absolute(origin, guidePagePath(content, chapter?.id ?? null))
    const image = absolute(origin, '/og/muvloom-og.jpg')
    tags.push(
      `<link rel="canonical" href="${url}" />`,
      `<meta property="og:url" content="${url}" />`,
      `<meta property="og:image" content="${image}" />`,
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      `<meta property="og:image:alt" content="${escapeHtml(content.meta.ogImageAlt)}" />`,
      `<meta name="twitter:image" content="${image}" />`,
      ...options.editions.map(
        (edition) =>
          `<link rel="alternate" hreflang="${edition.lang}" href="${absolute(origin, guidePagePath(edition, chapter?.id ?? null))}" />`,
      ),
      `<link rel="alternate" hreflang="x-default" href="${absolute(origin, guidePagePath(options.editions[0]!, chapter?.id ?? null))}" />`,
      `<script type="application/ld+json">${jsonLd(structuredData(content, chapter, options, origin))}</script>`,
    )
  }
  return tags.join('\n    ')
}

/* ────────────────────────────── chrome ────────────────────────────── */

function renderHeader(
  content: GuideContent,
  chapter: GuideChapter | null,
  options: GuideRenderOptions,
): string {
  const { chrome } = content
  const other = options.editions.find((edition) => edition.lang !== content.lang)
  const language = other
    ? `<a href="${guidePagePath(other, chapter?.id ?? null)}" hreflang="${other.lang}" lang="${other.lang}" class="whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">${escapeHtml(chrome.otherLanguage)}</a>`
    : ''
  return `<header class="fixed inset-x-0 top-3 z-40 px-3 sm:top-4 sm:px-4">
      <div class="mx-auto flex h-12 max-w-6xl items-center gap-2 rounded-full border border-border bg-background/75 pl-4 pr-1.5 shadow-lg shadow-black/[0.06] backdrop-blur-xl">
        <a href="/" class="flex shrink-0 items-center gap-2 whitespace-nowrap text-[14px] font-semibold"><img src="/brand/muvloom-mark.svg" alt="" width="24" height="24" class="h-6 w-6" />${escapeHtml(chrome.brand)}</a>
        <a href="${content.root}" class="hidden whitespace-nowrap px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline">${escapeHtml(chrome.title)}</a>
        <button type="button" data-search-open aria-label="${escapeHtml(chrome.search)}" class="ml-auto flex h-8 items-center gap-2 rounded-full border border-border bg-muted/40 px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground md:ml-4 md:w-56 md:px-3">${icon(Search, 'h-4 w-4')}<span class="hidden md:inline">${escapeHtml(chrome.search)}</span><kbd class="ml-auto hidden rounded border border-border bg-background px-1.5 font-mono text-[11px] md:inline">⌘K</kbd></button>
        <div class="flex shrink-0 items-center gap-1 md:ml-auto">${language}<a href="/" class="whitespace-nowrap rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90">${escapeHtml(chrome.start)}</a></div>
      </div>
    </header>`
}

function renderSearchDialog(content: GuideContent): string {
  const { chrome } = content
  return `<dialog data-search data-index="${content.root}search.json" data-empty="${escapeHtml(chrome.searchEmpty)}" class="m-0 h-full max-h-none w-full max-w-none bg-transparent p-4 backdrop:bg-black/50 backdrop:backdrop-blur-sm">
      <div data-search-panel class="mx-auto mt-[10vh] w-full max-w-[640px] overflow-hidden rounded-2xl border border-border bg-popover text-foreground shadow-2xl">
        <label class="flex h-14 items-center gap-3 border-b border-border px-5">${icon(Search, 'h-5 w-5 text-muted-foreground')}<input data-search-input type="search" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(chrome.searchPlaceholder)}" class="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" /><kbd class="rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground">Esc</kbd></label>
        <div data-search-results role="listbox" class="max-h-[60vh] overflow-y-auto p-2 empty:hidden"></div>
      </div>
    </dialog>`
}

function renderFooter(content: GuideContent, options: GuideRenderOptions): string {
  return `<footer class="border-t border-border">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-[13px] text-muted-foreground">
        <a href="/" class="flex items-center gap-2 font-medium text-foreground"><img src="/brand/muvloom-mark.svg" alt="" width="20" height="20" class="h-5 w-5" />${escapeHtml(content.chrome.brand)}</a>
        <span>${escapeHtml(content.chrome.updated)} <time datetime="${options.updated}">${options.updated}</time></span>
      </div>
    </footer>`
}

function renderDocument(
  content: GuideContent,
  chapter: GuideChapter | null,
  options: GuideRenderOptions,
  body: string,
): string {
  return `<!DOCTYPE html>
<html lang="${content.lang}">
  <head>
    ${renderHead(content, chapter, options)}
  </head>
  <body class="min-h-screen bg-background font-sans text-foreground antialiased">
    ${renderHeader(content, chapter, options)}
    ${body}
    ${renderSearchDialog(content)}
    <script type="module" src="/src/features/guide/client.ts"></script>
  </body>
</html>
`
}

/* ─────────────────────────────── home ─────────────────────────────── */

function renderHome(content: GuideContent, options: GuideRenderOptions): string {
  const { chrome } = content
  const { width, height } = options.imageSize(content.home.image)
  const first = content.chapters[0]!
  const cards = content.chapters
    .map(
      (chapter, index) =>
        `<a href="${guidePagePath(content, chapter.id)}" class="group relative flex min-h-[220px] flex-col overflow-hidden rounded-3xl border border-border bg-card/50 p-7 transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:bg-card ${index === 0 ? 'lg:col-span-2' : ''}"><span aria-hidden="true" class="pointer-events-none absolute -bottom-7 right-3 font-display text-[128px] font-bold leading-none text-foreground/[0.04] transition-colors group-hover:text-primary/10">${two(index)}</span><span class="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">${chapterIcon(chapter, 'h-5 w-5')}</span><h3 class="mt-6 text-[19px] font-semibold text-foreground">${escapeHtml(chapter.title)}</h3><p class="mt-2 max-w-[34ch] text-[14px] leading-6 text-muted-foreground">${escapeHtml(chapter.summary)}</p>${icon(ArrowUpRight, 'absolute right-6 top-7 h-5 w-5 text-muted-foreground transition-colors group-hover:text-primary')}</a>`,
    )
    .join('')
  const faq = content.faq.items
    .map(
      (item) =>
        `<div class="rounded-2xl border border-border bg-card/50 p-6"><h3 class="text-[16px] font-semibold leading-7 text-foreground">${escapeHtml(item.q)}</h3><p class="mt-2 text-[14.5px] leading-7 text-muted-foreground">${escapeHtml(item.a)}</p></div>`,
    )
    .join('')
  return `<main data-selectable-text>
      <section class="guide-hero relative overflow-hidden pb-6 pt-36 text-center sm:pt-44">
        <div class="relative mx-auto max-w-3xl px-6">
          <span class="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-[12px] text-muted-foreground">${icon(Sparkles, 'h-3.5 w-3.5 text-primary')}${escapeHtml(chrome.eyebrow)}</span>
          <h1 class="mt-6 bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text pb-1 font-display text-[52px] font-semibold leading-[1.08] tracking-[-0.03em] text-transparent sm:text-[76px]">${escapeHtml(chrome.title)}</h1>
          <p class="mx-auto mt-5 max-w-xl text-[17px] leading-8 text-muted-foreground sm:text-[18px]">${renderInline(chrome.lead)}</p>
          <div class="mt-9 flex flex-wrap justify-center gap-3"><a href="${guidePagePath(content, first.id)}" class="inline-flex items-center gap-2 rounded-full bg-foreground px-6 py-3 text-[14px] font-semibold text-background transition-opacity hover:opacity-90">${escapeHtml(chrome.startReading)}${icon(ArrowRight, 'h-4 w-4')}</a><a href="/" class="rounded-full border border-border px-6 py-3 text-[14px] font-medium text-foreground transition-colors hover:bg-muted">${escapeHtml(chrome.start)}</a></div>
        </div>
        <div class="guide-hero-fade relative mx-auto mt-16 max-w-5xl px-4 sm:px-6">
          <div class="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.55)]"><div class="flex h-8 items-center gap-1.5 border-b border-border bg-muted/60 px-3"><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span></div><img src="${escapeHtml(content.home.image)}" alt="${escapeHtml(content.home.imageAlt)}" width="${width}" height="${height}" fetchpriority="high" class="block h-auto w-full" /></div>
        </div>
      </section>
      <section aria-labelledby="chapters" class="mx-auto max-w-6xl px-6 pb-28">
        <h2 id="chapters" class="mb-6 text-[13px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">${escapeHtml(chrome.chaptersTitle)}</h2>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
      </section>
      <section aria-labelledby="${content.faq.id}" class="border-t border-border py-28">
        <div class="mx-auto max-w-6xl px-6">
          <h2 id="${content.faq.id}" class="scroll-mt-24 text-center font-display text-[36px] font-semibold tracking-tight sm:text-[48px]">${escapeHtml(content.faq.title)}</h2>
          <div class="mt-14 grid gap-4 md:grid-cols-2">${faq}</div>
          <div class="guide-cta mt-20 overflow-hidden rounded-3xl border border-primary/25 px-8 py-14 text-center"><p class="font-display text-[28px] font-semibold tracking-tight sm:text-[32px]">${escapeHtml(chrome.ctaTitle)}</p><a href="/" class="mt-6 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90">${escapeHtml(chrome.start)}${icon(ArrowRight, 'h-4 w-4')}</a></div>
        </div>
      </section>
    </main>
    ${renderFooter(content, options)}`
}

/* ───────────────────────────── chapters ───────────────────────────── */

function renderChapterNav(content: GuideContent, current: GuideChapter): string {
  const chapters = content.chapters
    .map((chapter) => {
      const here = chapter.id === current.id
      const entries = [
        ...chapter.subsections.map((sub) => ({ id: sub.id, title: sub.title })),
        ...(chapter.faq ? [{ id: content.faq.id, title: content.faq.title }] : []),
      ]
      const subsections = entries
        .map(
          (entry) =>
            `<li><a href="${here ? '' : guidePagePath(content, chapter.id)}#${entry.id}" ${here ? `data-toc="${entry.id}"` : ''} class="-ml-px block border-l border-transparent py-[5px] pl-4 text-[13.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground aria-[current=true]:border-primary aria-[current=true]:font-medium aria-[current=true]:text-foreground">${escapeHtml(entry.title)}</a></li>`,
        )
        .join('')
      return `<div class="mb-7"><a href="${guidePagePath(content, chapter.id)}" ${here ? 'aria-current="page"' : ''} class="mb-2 flex items-center gap-2 text-[13px] font-semibold text-foreground/80 transition-colors hover:text-foreground aria-[current=page]:text-foreground">${chapterIcon(chapter, `h-4 w-4 ${here ? 'text-primary' : 'text-muted-foreground'}`)}${escapeHtml(chapter.title)}</a><ul class="ml-2 border-l border-border">${subsections}</ul></div>`
    })
    .join('')
  return `${chapters}<a href="${content.root}#${content.faq.id}" class="flex items-center gap-2 text-[13px] font-semibold text-foreground/80 transition-colors hover:text-foreground">${icon(CircleHelp, 'h-4 w-4 text-muted-foreground')}${escapeHtml(content.faq.title)}</a>`
}

function renderPager(content: GuideContent, index: number): string {
  const prev = content.chapters[index - 1]
  const next = content.chapters[index + 1]
  const link = (chapter: GuideChapter | undefined, label: string, align: 'left' | 'right') =>
    chapter
      ? `<a href="${guidePagePath(content, chapter.id)}" class="group rounded-xl border border-border p-4 transition-colors hover:border-primary/40 ${align === 'right' ? 'text-right sm:col-start-2' : ''}"><span class="flex items-center gap-1.5 text-[12.5px] text-muted-foreground ${align === 'right' ? 'justify-end' : ''}">${align === 'left' ? icon(ArrowLeft, 'h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5') : ''}${escapeHtml(label)}${align === 'right' ? icon(ArrowRight, 'h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5') : ''}</span><span class="mt-1 block text-[15px] font-semibold text-foreground">${escapeHtml(chapter.title)}</span></a>`
      : ''
  return `<nav class="mt-20 grid gap-3 sm:grid-cols-2">${link(prev, content.chrome.prev, 'left')}${link(next, content.chrome.next, 'right')}</nav>`
}

function renderChapter(
  content: GuideContent,
  chapter: GuideChapter,
  options: GuideRenderOptions,
): string {
  const { chrome } = content
  const index = content.chapters.indexOf(chapter)
  const nav = renderChapterNav(content, chapter)
  const railEntries = [
    ...chapter.subsections.map((sub) => ({ id: sub.id, title: sub.title })),
    ...(chapter.faq ? [{ id: content.faq.id, title: content.faq.title }] : []),
  ]
  const rail = railEntries
    .map(
      (entry) =>
        `<li><a href="#${entry.id}" data-toc="${entry.id}" class="block py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-[current=true]:text-primary">${escapeHtml(entry.title)}</a></li>`,
    )
    .join('')
  const subsections = chapter.subsections
    .map(
      (sub) =>
        `<h2 id="${sub.id}" data-heading class="group mt-16 flex scroll-mt-24 items-center gap-2 text-[22px] font-semibold tracking-tight text-foreground">${escapeHtml(sub.title)}<a href="#${sub.id}" aria-hidden="true" tabindex="-1" class="text-border opacity-0 transition-opacity group-hover:opacity-100">#</a></h2>${renderBlocks(sub.blocks, content, options)}`,
    )
    .join('')
  const faq = chapter.faq
    ? `<h2 id="${content.faq.id}" data-heading class="mt-16 scroll-mt-24 text-[22px] font-semibold tracking-tight text-foreground">${escapeHtml(content.faq.title)}</h2><div class="mt-6 divide-y divide-border border-y border-border">${chapter.faq
        .map(
          (item) =>
            `<details class="group py-4"><summary class="flex cursor-pointer list-none items-center justify-between gap-6 text-[15.5px] font-medium text-foreground [&::-webkit-details-marker]:hidden">${escapeHtml(item.q)}${icon(ChevronDown, 'h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180')}</summary><p class="mt-2.5 pr-10 text-[14.5px] leading-7 text-muted-foreground">${escapeHtml(item.a)}</p></details>`,
        )
        .join('')}</div>`
    : ''
  return `<div class="mx-auto flex max-w-[1400px] pt-[76px]">
      <aside class="sticky top-[76px] hidden h-[calc(100vh-76px)] w-[272px] shrink-0 overflow-y-auto border-r border-border px-6 pb-10 pt-8 lg:block">
        <nav aria-label="${escapeHtml(chrome.toc)}">${nav}</nav>
      </aside>
      <main class="min-w-0 flex-1 px-5 pb-28 pt-8 sm:px-10 lg:px-16" data-selectable-text>
        <article class="mx-auto max-w-[740px]">
          <p class="text-[13px] text-muted-foreground"><a href="${content.root}" class="transition-colors hover:text-foreground">${escapeHtml(chrome.title)}</a><span aria-hidden="true" class="mx-2 text-border">/</span><span class="text-foreground">${escapeHtml(chapter.title)}</span></p>
          <details data-mobile-toc class="mt-6 rounded-xl border border-border lg:hidden">
            <summary class="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-medium [&::-webkit-details-marker]:hidden">${escapeHtml(chrome.toc)}${icon(ChevronDown, 'h-4 w-4 text-muted-foreground')}</summary>
            <nav aria-label="${escapeHtml(chrome.toc)}" class="border-t border-border px-4 pt-5">${nav}</nav>
          </details>
          <p class="mt-10 font-mono text-[12px] font-medium tracking-wider text-primary">${escapeHtml(chrome.chapterLabel.replace('{n}', two(index)))}</p>
          <h1 class="mt-2 text-[36px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[40px]">${escapeHtml(chapter.title)}</h1>
          <p class="mt-3 text-[17px] leading-8 text-muted-foreground">${escapeHtml(chapter.summary)}</p>
          <div class="mt-8 h-px bg-border"></div>
          ${renderBlocks(chapter.intro ?? [], content, options)}
          ${subsections}
          ${faq}
          ${renderPager(content, index)}
        </article>
      </main>
      <aside class="sticky top-[76px] hidden h-[calc(100vh-76px)] w-56 shrink-0 overflow-y-auto pb-10 pr-6 pt-16 xl:block">
        <p class="mb-3 text-[12px] font-semibold text-muted-foreground">${escapeHtml(chrome.onThisPage)}</p>
        <ul class="space-y-1">${rail}</ul>
      </aside>
    </div>
    ${renderFooter(content, options)}`
}

/** 渲染一个完整页面：`chapterId` 为 null 时是首页。 */
export function renderGuidePage(
  content: GuideContent,
  chapterId: string | null,
  options: GuideRenderOptions,
): string {
  if (chapterId === null)
    return renderDocument(content, null, options, renderHome(content, options))
  const chapter = content.chapters.find((c) => c.id === chapterId)
  if (!chapter) throw new Error(`guide: unknown chapter ${chapterId}`)
  return renderDocument(content, chapter, options, renderChapter(content, chapter, options))
}

/** 站内搜索索引：每个小节一条，外加常见问题。客户端按需拉取。 */
export function buildSearchIndex(content: GuideContent) {
  const blockText = (block: Block): string[] => {
    switch (block.type) {
      case 'p':
      case 'callout':
        return [block.text]
      case 'steps':
      case 'list':
        return block.items
      case 'table':
        return block.rows.flat()
      case 'prompt':
        return [block.label, block.text]
      case 'shot':
        return block.caption ? [block.caption] : []
    }
  }
  return [
    ...content.chapters.flatMap((chapter) => [
      ...chapter.subsections.map((sub) => ({
        chapter: chapter.title,
        title: sub.title,
        url: `${guidePagePath(content, chapter.id)}#${sub.id}`,
        text: sub.blocks.flatMap(blockText).map(plainInline).join(' '),
      })),
      ...(chapter.faq ?? []).map((item) => ({
        chapter: `${chapter.title} · ${content.faq.title}`,
        title: item.q,
        url: `${guidePagePath(content, chapter.id)}#${content.faq.id}`,
        text: item.a,
      })),
    ]),
    ...content.faq.items.map((item) => ({
      chapter: content.faq.title,
      title: item.q,
      url: `${content.root}#${content.faq.id}`,
      text: item.a,
    })),
  ]
}
