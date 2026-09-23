import type { Block, GuideContent, Inline } from './model'

/**
 * 构建期把一份 `GuideContent` 渲染成完整的 HTML 文档。正文、标题层级与结构化数据都在
 * HTML 里，搜索引擎不必执行脚本；浏览器端的 `client.ts` 只负责目录高亮。
 *
 * 类名必须整串写在本文件里，Tailwind 才扫得到。
 */

export interface GuideRenderOptions {
  /** 站点的公开源（`https://muvloom.online`）。缺席时不写绝对地址：canonical、og:url、hreflang 都省掉。 */
  origin: string | null
  /** false 时加 `noindex`：测试站与内部站不该出现在搜索结果里。 */
  indexing: boolean
  /** 同一份指南的全部语言版本，用来写 hreflang 与语言切换。 */
  alternates: { lang: GuideContent['lang']; path: string }[]
  /** 截图的像素尺寸，写进 width/height 免得图片加载时页面跳动。 */
  imageSize: (src: string) => { width: number; height: number }
  /** 构建日期，`YYYY-MM-DD`。 */
  updated: string
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
      '<span class="mx-0.5 inline-flex items-center whitespace-nowrap rounded-md border border-border bg-secondary px-1.5 py-px align-baseline text-[0.86em] font-medium leading-snug text-foreground">$1</span>',
    )
    .replace(
      /\{\{(.+?)\}\}/g,
      '<kbd class="mx-0.5 inline-flex min-w-[1.6em] items-center justify-center rounded-md border border-border border-b-2 bg-card px-1.5 py-px font-mono text-[0.8em] leading-snug text-foreground">$1</kbd>',
    )
    .replace(
      /`([^`]+)`/g,
      '<code class="rounded bg-secondary px-1 py-px font-mono text-[0.86em] text-foreground">$1</code>',
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label: string, href: string) =>
        `<a class="font-medium text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary" href="${safeHref(href)}">${label}</a>`,
    )
}

const CALLOUT: Record<'tip' | 'note' | 'warn', { box: string; badge: string }> = {
  tip: { box: 'border-primary/30 bg-primary/5', badge: 'bg-primary/15 text-primary' },
  note: { box: 'border-border bg-secondary/60', badge: 'bg-secondary text-muted-foreground' },
  warn: { box: 'border-warning/40 bg-warning/5', badge: 'bg-warning/15 text-warning' },
}

function renderBlock(block: Block, content: GuideContent, options: GuideRenderOptions): string {
  switch (block.type) {
    case 'p':
      return `<p class="my-4 leading-7 text-muted-foreground">${renderInline(block.text)}</p>`
    case 'steps':
      return `<ol class="my-5 space-y-3">${block.items
        .map(
          (item, index) =>
            `<li class="flex gap-3 leading-7 text-muted-foreground"><span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">${index + 1}</span><span class="min-w-0">${renderInline(item)}</span></li>`,
        )
        .join('')}</ol>`
    case 'list':
      return `<ul class="my-4 space-y-2">${block.items
        .map(
          (item) =>
            `<li class="relative pl-5 leading-7 text-muted-foreground before:absolute before:left-1 before:top-[0.7em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-primary/70">${renderInline(item)}</li>`,
        )
        .join('')}</ul>`
    case 'callout': {
      const style = CALLOUT[block.tone]
      const label =
        content.chrome[
          block.tone === 'tip' ? 'tipLabel' : block.tone === 'warn' ? 'warnLabel' : 'noteLabel'
        ]
      return `<aside class="my-5 flex gap-3 rounded-xl border px-4 py-3 ${style.box}"><span class="mt-0.5 h-fit shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold ${style.badge}">${escapeHtml(label)}</span><p class="min-w-0 leading-7 text-muted-foreground">${renderInline(block.text)}</p></aside>`
    }
    case 'shot': {
      const { width, height } = options.imageSize(block.src)
      const marks = (block.marks ?? [])
        .map(
          (mark, index) =>
            `<span aria-hidden="true" class="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-[0_0_0_3px_hsl(var(--background)/0.85)]" style="left:${mark.x}%;top:${mark.y}%">${index + 1}</span>`,
        )
        .join('')
      const caption = block.caption
        ? `<figcaption class="mt-2 text-center text-sm text-muted-foreground">${renderInline(block.caption)}</figcaption>`
        : ''
      return `<figure class="my-6"><a class="relative block overflow-hidden rounded-xl border border-border bg-card" href="${escapeHtml(block.src)}" target="_blank" rel="noopener"><img class="block h-auto w-full" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" width="${width}" height="${height}" loading="lazy" decoding="async" />${marks}</a>${caption}</figure>`
    }
    case 'table':
      return `<div class="my-5 overflow-x-auto rounded-xl border border-border"><table class="w-full border-collapse text-left text-sm"><thead class="bg-secondary/60"><tr>${block.head
        .map(
          (cell) =>
            `<th class="px-4 py-2.5 font-semibold text-foreground">${renderInline(cell)}</th>`,
        )
        .join('')}</tr></thead><tbody>${block.rows
        .map(
          (row) =>
            `<tr class="border-t border-border">${row
              .map(
                (cell) =>
                  `<td class="px-4 py-2.5 align-top leading-6 text-muted-foreground">${renderInline(cell)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`
    case 'cards':
      return `<div class="my-5 grid gap-3 sm:grid-cols-2">${block.items
        .map((item) => {
          const body = `<p class="font-semibold text-foreground">${renderInline(item.title)}</p><p class="mt-1 text-sm leading-6 text-muted-foreground">${renderInline(item.text)}</p>`
          return item.href
            ? `<a class="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50" href="${safeHref(item.href)}">${body}</a>`
            : `<div class="rounded-xl border border-border bg-card p-4">${body}</div>`
        })
        .join('')}</div>`
    case 'prompt':
      return `<figure class="my-5 rounded-xl border border-border bg-card px-4 py-3"><figcaption class="text-xs font-medium text-muted-foreground">${renderInline(block.label)}</figcaption><blockquote class="mt-1.5 leading-7 text-foreground" data-selectable-text>${escapeHtml(block.text)}</blockquote></figure>`
  }
}

function renderBlocks(blocks: Block[], content: GuideContent, options: GuideRenderOptions): string {
  return blocks.map((block) => renderBlock(block, content, options)).join('')
}

const TOC_LINK =
  'block rounded-lg px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=true]:bg-accent aria-[current=true]:font-medium aria-[current=true]:text-foreground'
const TOC_SUB_LINK =
  'block rounded-md py-1 pl-6 pr-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-[current=true]:text-primary'

function renderToc(content: GuideContent): string {
  const sections = content.sections
    .map(
      (section) =>
        `<li><a class="${TOC_LINK}" href="#${section.id}" data-toc="${section.id}">${escapeHtml(section.title)}</a><ul class="mb-1" data-toc-group="${section.id}">${section.subsections
          .map(
            (sub) =>
              `<li><a class="${TOC_SUB_LINK}" href="#${sub.id}" data-toc="${sub.id}" data-toc-parent="${section.id}">${escapeHtml(sub.title)}</a></li>`,
          )
          .join('')}</ul></li>`,
    )
    .join('')
  const faq = `<li><a class="${TOC_LINK}" href="#${content.faq.id}" data-toc="${content.faq.id}">${escapeHtml(content.faq.title)}</a></li>`
  return `<ul class="space-y-0.5 text-sm">${sections}${faq}</ul>`
}

function renderArticle(content: GuideContent, options: GuideRenderOptions): string {
  const sections = content.sections
    .map(
      (section) =>
        `<section aria-labelledby="${section.id}" class="border-t border-border pt-10 first:border-t-0 first:pt-0"><h2 id="${section.id}" data-heading class="scroll-mt-24 text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">${escapeHtml(section.title)}</h2>${renderBlocks(section.intro ?? [], content, options)}${section.subsections
          .map(
            (sub) =>
              `<h3 id="${sub.id}" data-heading class="mt-10 scroll-mt-24 text-lg font-semibold text-foreground">${escapeHtml(sub.title)}</h3>${renderBlocks(sub.blocks, content, options)}`,
          )
          .join('')}</section>`,
    )
    .join('<div class="h-14"></div>')
  const faq = `<section aria-labelledby="${content.faq.id}" class="mt-14 border-t border-border pt-10"><h2 id="${content.faq.id}" data-heading class="scroll-mt-24 text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">${escapeHtml(content.faq.title)}</h2><div class="mt-6 divide-y divide-border rounded-xl border border-border bg-card">${content.faq.items
    .map(
      (item) =>
        `<details class="group px-4 py-3"><summary class="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-foreground [&::-webkit-details-marker]:hidden">${escapeHtml(item.q)}<span aria-hidden="true" class="text-muted-foreground transition-transform group-open:rotate-45">+</span></summary><p class="mt-2 leading-7 text-muted-foreground">${escapeHtml(item.a)}</p></details>`,
    )
    .join('')}</div></section>`
  return sections + faq
}

function absolute(origin: string, path: string): string {
  return new URL(path, origin).toString()
}

function renderHead(content: GuideContent, options: GuideRenderOptions): string {
  const { meta } = content
  const tags = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    '<link rel="icon" href="/brand/muvloom-icon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />',
    '<meta property="og:type" content="article" />',
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:locale" content="${content.lang === 'en' ? 'en_US' : 'zh_CN'}" />`,
    `<meta property="og:site_name" content="${escapeHtml(content.chrome.brand)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
  ]
  if (!options.indexing) tags.push('<meta name="robots" content="noindex, nofollow" />')
  if (options.origin) {
    const origin = options.origin
    const image = absolute(origin, '/og/muvloom-og.jpg')
    tags.push(
      `<link rel="canonical" href="${absolute(origin, content.path)}" />`,
      `<meta property="og:url" content="${absolute(origin, content.path)}" />`,
      `<meta property="og:image" content="${image}" />`,
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      `<meta property="og:image:alt" content="${escapeHtml(meta.ogImageAlt)}" />`,
      `<meta name="twitter:image" content="${image}" />`,
      ...options.alternates.map(
        (alt) =>
          `<link rel="alternate" hreflang="${alt.lang}" href="${absolute(origin, alt.path)}" />`,
      ),
      `<link rel="alternate" hreflang="x-default" href="${absolute(origin, options.alternates[0]!.path)}" />`,
    )
    tags.push(
      `<script type="application/ld+json">${jsonLd(structuredData(content, options, origin))}</script>`,
    )
  }
  return tags.join('\n    ')
}

/** JSON 里的 `</script>` 会提前关掉标签；`<` 统一转义。 */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function structuredData(content: GuideContent, options: GuideRenderOptions, origin: string) {
  const url = absolute(origin, content.path)
  const publisher = {
    '@type': 'Organization',
    name: content.chrome.brand,
    url: absolute(origin, '/'),
    logo: absolute(origin, '/brand/apple-touch-icon.png'),
  }
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: content.meta.title,
      description: content.meta.description,
      inLanguage: content.lang,
      url,
      mainEntityOfPage: url,
      image: absolute(origin, '/og/muvloom-og.jpg'),
      dateModified: options.updated,
      author: publisher,
      publisher,
      about: { '@type': 'WebApplication', name: content.chrome.brand, url: absolute(origin, '/') },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: content.chrome.brand,
          item: absolute(origin, '/'),
        },
        { '@type': 'ListItem', position: 2, name: content.chrome.title, item: url },
      ],
    },
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
}

export function renderGuideDocument(content: GuideContent, options: GuideRenderOptions): string {
  const other = options.alternates.find((alt) => alt.lang !== content.lang)
  const { chrome } = content
  return `<!DOCTYPE html>
<html lang="${content.lang}">
  <head>
    ${renderHead(content, options)}
  </head>
  <body class="min-h-screen bg-background font-sans text-foreground antialiased">
    <header class="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <a href="/" class="flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold"><img src="/brand/muvloom-mark.svg" alt="" width="28" height="28" class="h-7 w-7" /><span>${escapeHtml(chrome.brand)}</span></a>
        <span aria-hidden="true" class="hidden text-border sm:inline">/</span>
        <span class="hidden whitespace-nowrap text-sm text-muted-foreground sm:inline">${escapeHtml(chrome.title)}</span>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          ${other ? `<a href="${other.path}" hreflang="${other.lang}" lang="${other.lang}" class="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">${escapeHtml(chrome.otherLanguage)}</a>` : ''}
          <a href="/" class="whitespace-nowrap rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">${escapeHtml(chrome.start)}</a>
        </div>
      </div>
    </header>
    <div class="mx-auto max-w-6xl px-4 sm:px-6" data-selectable-text>
      <div class="pb-8 pt-12 sm:pt-16">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-primary">${escapeHtml(chrome.eyebrow)}</p>
        <h1 class="mt-3 font-display text-4xl font-semibold tracking-tight sm:text-5xl">${escapeHtml(chrome.title)}</h1>
        <p class="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">${renderInline(chrome.lead)}</p>
        <p class="mt-3 text-xs text-muted-foreground">${escapeHtml(chrome.updated)} <time datetime="${options.updated}">${options.updated}</time></p>
      </div>
      <details class="mb-8 rounded-xl border border-border bg-card lg:hidden" data-mobile-toc>
        <summary class="cursor-pointer list-none px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">${escapeHtml(chrome.toc)}</summary>
        <div class="border-t border-border px-1 py-2">${renderToc(content)}</div>
      </details>
      <div class="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <aside class="hidden lg:block">
          <nav aria-label="${escapeHtml(chrome.toc)}" class="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-border bg-card p-2">
            <p class="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">${escapeHtml(chrome.toc)}</p>
            ${renderToc(content)}
          </nav>
        </aside>
        <main class="min-w-0 max-w-3xl pb-24">
          ${renderArticle(content, options)}
          <p class="mt-16"><a href="#top" class="text-sm text-muted-foreground hover:text-foreground">↑ ${escapeHtml(chrome.backToTop)}</a></p>
        </main>
      </div>
    </div>
    <script type="module" src="/src/features/guide/client.ts"></script>
  </body>
</html>
`
}
