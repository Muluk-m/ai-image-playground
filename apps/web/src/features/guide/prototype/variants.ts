/**
 * PROTOTYPE — throwaway. 使用指南的三版视觉方案，只在 Vite dev server 上渲染：
 * `/guide/?variant=A|B|C`，底部浮条或 ←/→ 切换。选定后把胜出方案重写进 `render.ts`，本目录整体删除。
 *
 * A「文档」：三栏技术文档（左目录树、正文、右侧本页导航），克制排版。
 * B「杂志」：大标题与产品截图的首屏、章节卡片、横向章节导航、左右分栏的小节。
 * C「帮助中心」：搜索优先的首屏、分类卡片、折叠目录与卡片式文章。
 */
import {
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
import type { Block, GuideContent, GuideSection } from '../model'
import { escapeHtml, renderInline } from '../render'

type LucideIcon = typeof Sparkles

export interface PrototypeOptions {
  imageSize: (src: string) => { width: number; height: number }
  alternates: { lang: GuideContent['lang']; path: string }[]
  updated: string
}

export const VARIANTS = {
  A: '文档',
  B: '杂志',
  C: '帮助中心',
} as const
export type VariantKey = keyof typeof VARIANTS

const icon = (Icon: LucideIcon, className: string) =>
  renderToStaticMarkup(createElement(Icon, { className, strokeWidth: 1.75, 'aria-hidden': true }))

const SECTION_ICONS: Record<string, LucideIcon> = {
  intro: Sparkles,
  'quick-start': Rocket,
  create: WandSparkles,
  canvas: Frame,
  agent: Bot,
  assets: FolderOpen,
}
const sectionIcon = (section: GuideSection) => SECTION_ICONS[section.id] ?? Sparkles
const two = (n: number) => String(n + 1).padStart(2, '0')

const TONE_ICON = { tip: Lightbulb, note: Info, warn: TriangleAlert } as const

/** 每个方案给同一组区块配一套样式；结构差异放在各自的版式函数里。 */
interface BlockStyle {
  p: string
  list: string
  listItem: string
  steps: (items: string[]) => string
  callout: (tone: 'tip' | 'note' | 'warn', label: string, text: string) => string
  shot: (img: string, caption: string, marks: string) => string
  mark: string
  table: { wrap: string; th: string; td: string; row: string; head: string }
  cards: (items: { title: string; text: string; href?: string }[]) => string
  prompt: (label: string, text: string) => string
}

function renderBlock(
  block: Block,
  style: BlockStyle,
  content: GuideContent,
  options: PrototypeOptions,
): string {
  switch (block.type) {
    case 'p':
      return `<p class="${style.p}">${renderInline(block.text)}</p>`
    case 'list':
      return `<ul class="${style.list}">${block.items.map((item) => `<li class="${style.listItem}">${renderInline(item)}</li>`).join('')}</ul>`
    case 'steps':
      return style.steps(block.items.map(renderInline))
    case 'callout': {
      const label =
        content.chrome[
          block.tone === 'tip' ? 'tipLabel' : block.tone === 'warn' ? 'warnLabel' : 'noteLabel'
        ]
      return style.callout(block.tone, escapeHtml(label), renderInline(block.text))
    }
    case 'shot': {
      const { width, height } = options.imageSize(block.src)
      const marks = (block.marks ?? [])
        .map(
          (m, i) =>
            `<span aria-hidden="true" class="${style.mark}" style="left:${m.x}%;top:${m.y}%">${i + 1}</span>`,
        )
        .join('')
      const img = `<img class="block h-auto w-full" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" width="${width}" height="${height}" loading="lazy" decoding="async" />`
      return style.shot(img, block.caption ? renderInline(block.caption) : '', marks)
    }
    case 'table':
      return `<div class="${style.table.wrap}"><table class="w-full border-collapse text-left"><thead class="${style.table.head}"><tr>${block.head.map((h) => `<th class="${style.table.th}">${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${block.rows
        .map(
          (row) =>
            `<tr class="${style.table.row}">${row.map((cell) => `<td class="${style.table.td}">${renderInline(cell)}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`
    case 'cards':
      return style.cards(
        block.items.map((i) => ({
          title: renderInline(i.title),
          text: renderInline(i.text),
          href: i.href,
        })),
      )
    case 'prompt':
      return style.prompt(renderInline(block.label), escapeHtml(block.text))
  }
}

const blocks = (
  list: Block[],
  style: BlockStyle,
  content: GuideContent,
  options: PrototypeOptions,
) => list.map((b) => renderBlock(b, style, content, options)).join('')

function languageLink(content: GuideContent, options: PrototypeOptions, cls: string): string {
  const other = options.alternates.find((alt) => alt.lang !== content.lang)
  return other
    ? `<a href="${other.path}" hreflang="${other.lang}" lang="${other.lang}" class="${cls}">${escapeHtml(content.chrome.otherLanguage)}</a>`
    : ''
}

/* ───────────────────────────── A · 文档 ───────────────────────────── */

const styleA: BlockStyle = {
  p: 'my-5 text-[15.5px] leading-[1.9] text-foreground/75',
  list: 'my-5 space-y-2.5',
  listItem:
    'relative pl-5 text-[15.5px] leading-[1.85] text-foreground/75 before:absolute before:left-0.5 before:top-[0.8em] before:h-[5px] before:w-[5px] before:rounded-full before:bg-foreground/35',
  steps: (items) =>
    `<ol class="my-6">${items
      .map(
        (item, i) =>
          `<li class="relative pb-5 pl-11 last:pb-0"><span class="absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full border border-border bg-background font-mono text-[12px] font-medium text-foreground/80">${i + 1}</span>${i < items.length - 1 ? '<span aria-hidden="true" class="absolute bottom-0 left-[13.5px] top-8 w-px bg-border"></span>' : ''}<div class="pt-0.5 text-[15.5px] leading-[1.85] text-foreground/75">${item}</div></li>`,
      )
      .join('')}</ol>`,
  callout: (tone, label, text) => {
    const tint = {
      tip: 'border-l-primary',
      note: 'border-l-foreground/30',
      warn: 'border-l-warning',
    }[tone]
    const ic = { tip: 'text-primary', note: 'text-muted-foreground', warn: 'text-warning' }[tone]
    return `<aside class="my-6 flex gap-3 rounded-r-lg border-l-2 ${tint} bg-muted/50 px-4 py-3.5">${icon(TONE_ICON[tone], `mt-[3px] h-4 w-4 shrink-0 ${ic}`)}<div class="text-[14.5px] leading-7 text-foreground/75"><span class="font-semibold text-foreground">${label}</span><span class="mx-1.5 text-border">|</span>${text}</div></aside>`
  },
  shot: (img, caption, marks) =>
    `<figure class="my-8"><div class="rounded-xl border border-border bg-muted/40 p-1.5"><div class="relative overflow-hidden rounded-lg">${img}${marks}</div></div>${caption ? `<figcaption class="mt-3 text-center text-[13px] text-muted-foreground">${caption}</figcaption>` : ''}</figure>`,
  mark: 'absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary font-mono text-[11px] font-bold text-primary-foreground ring-[3px] ring-background',
  table: {
    wrap: 'my-6 overflow-x-auto',
    head: 'border-b border-foreground/15',
    th: 'py-2.5 pr-6 text-[12px] font-medium uppercase tracking-wider text-muted-foreground',
    td: 'py-3 pr-6 align-top text-[14.5px] leading-7 text-foreground/75',
    row: 'border-b border-border/70',
  },
  cards: (items) =>
    `<div class="my-6 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2">${items
      .map(
        (item) =>
          `<a href="${item.href ?? '#'}" class="group -mb-px -mr-px border-b border-r border-border p-5 transition-colors hover:bg-muted/40"><p class="flex items-center justify-between text-[15px] font-semibold text-foreground">${item.title}${icon(ArrowRight, 'h-4 w-4 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100')}</p><p class="mt-1.5 text-[13.5px] leading-6 text-muted-foreground">${item.text}</p></a>`,
      )
      .join('')}</div>`,
  prompt: (label, text) =>
    `<figure class="my-6 overflow-hidden rounded-xl border border-border"><figcaption class="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2 text-[12px] font-medium text-muted-foreground">${label}${icon(Copy, 'h-3.5 w-3.5')}</figcaption><blockquote class="px-4 py-3.5 text-[14.5px] leading-7 text-foreground/85" data-selectable-text>${text}</blockquote></figure>`,
}

function variantA(content: GuideContent, options: PrototypeOptions): string {
  const { chrome } = content
  const nav = content.sections
    .map(
      (s, i) =>
        `<div class="mb-7"><a href="#${s.id}" data-toc="${s.id}" class="mb-2 flex items-center gap-2 text-[13px] font-semibold text-foreground">${icon(sectionIcon(s), 'h-4 w-4 text-muted-foreground')}${escapeHtml(s.title)}</a><ul class="ml-2 border-l border-border">${s.subsections
          .map(
            (sub) =>
              `<li><a href="#${sub.id}" data-toc="${sub.id}" data-toc-parent="${s.id}" class="-ml-px block border-l border-transparent py-[5px] pl-4 text-[13.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground aria-[current=true]:border-primary aria-[current=true]:font-medium aria-[current=true]:text-foreground">${escapeHtml(sub.title)}</a></li>`,
          )
          .join('')}</ul></div>`,
    )
    .join('')
  const rail = content.sections
    .map(
      (s) =>
        `<ul data-toc-group="${s.id}" class="space-y-1">${s.subsections
          .map(
            (sub) =>
              `<li><a href="#${sub.id}" data-toc="${sub.id}" data-toc-parent="${s.id}" class="block py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-[current=true]:text-primary">${escapeHtml(sub.title)}</a></li>`,
          )
          .join('')}</ul>`,
    )
    .join('')
  const chapters = content.sections
    .map(
      (s, i) =>
        `<section class="mt-24 first:mt-16"><p class="font-mono text-[12px] font-medium tracking-wider text-primary">${content.lang === 'en' ? 'CHAPTER' : '第'} ${two(i)}${content.lang === 'en' ? '' : ' 章'}</p><h2 id="${s.id}" data-heading class="mt-2 scroll-mt-24 text-[30px] font-semibold tracking-tight text-foreground">${escapeHtml(s.title)}</h2><p class="mt-3 text-[17px] leading-8 text-muted-foreground">${escapeHtml(s.summary)}</p><div class="mt-8 h-px bg-border"></div>${blocks(s.intro ?? [], styleA, content, options)}${s.subsections
          .map(
            (sub) =>
              `<h3 id="${sub.id}" data-heading class="group mt-14 flex scroll-mt-24 items-center gap-2 text-[21px] font-semibold tracking-tight text-foreground">${escapeHtml(sub.title)}<a href="#${sub.id}" class="text-border opacity-0 transition group-hover:opacity-100">#</a></h3>${blocks(sub.blocks, styleA, content, options)}`,
          )
          .join('')}</section>`,
    )
    .join('')
  const faq = `<section class="mt-24"><h2 id="${content.faq.id}" data-heading class="scroll-mt-24 text-[30px] font-semibold tracking-tight">${escapeHtml(content.faq.title)}</h2><div class="mt-8 divide-y divide-border border-y border-border">${content.faq.items
    .map(
      (f) =>
        `<details class="group py-4"><summary class="flex cursor-pointer list-none items-center justify-between gap-6 text-[15.5px] font-medium text-foreground [&::-webkit-details-marker]:hidden">${escapeHtml(f.q)}${icon(ChevronDown, 'h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-180')}</summary><p class="mt-2.5 pr-10 text-[14.5px] leading-7 text-muted-foreground">${escapeHtml(f.a)}</p></details>`,
    )
    .join('')}</div></section>`
  return `
  <header class="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
    <div class="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-6">
      <a href="/" class="flex items-center gap-2.5 text-[15px] font-semibold"><img src="/brand/muvloom-mark.svg" alt="" class="h-6 w-6" />${escapeHtml(chrome.brand)}<span class="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">${escapeHtml(chrome.title)}</span></a>
      <button type="button" class="ml-6 hidden h-9 w-72 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-[13px] text-muted-foreground lg:flex">${icon(Search, 'h-4 w-4')}${content.lang === 'en' ? 'Search the guide' : '搜索文档'}<kbd class="ml-auto rounded border border-border bg-background px-1.5 font-mono text-[11px]">⌘K</kbd></button>
      <div class="ml-auto flex items-center gap-1">${languageLink(content, options, 'rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground')}<a href="/" class="ml-2 rounded-lg bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background hover:opacity-90">${escapeHtml(chrome.start)}</a></div>
    </div>
  </header>
  <div class="mx-auto flex max-w-[1400px]">
    <aside class="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[272px] shrink-0 overflow-y-auto border-r border-border px-6 py-10 lg:block">${nav}<a href="#${content.faq.id}" data-toc="${content.faq.id}" class="flex items-center gap-2 text-[13px] font-semibold text-foreground">${icon(CircleHelp, 'h-4 w-4 text-muted-foreground')}${escapeHtml(content.faq.title)}</a></aside>
    <main class="min-w-0 flex-1 px-6 pb-32 pt-14 sm:px-10 lg:px-16" data-selectable-text>
      <div class="mx-auto max-w-[740px]">
        <p class="text-[13px] text-muted-foreground">${escapeHtml(chrome.eyebrow)}<span class="mx-2 text-border">/</span><span class="text-foreground">${escapeHtml(chrome.title)}</span></p>
        <h1 class="mt-4 text-[44px] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground">${escapeHtml(chrome.title)}</h1>
        <p class="mt-4 text-[18px] leading-8 text-muted-foreground">${renderInline(chrome.lead)}</p>
        <div class="mt-10 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2">${content.sections
          .map(
            (s, i) =>
              `<a href="#${s.id}" class="group -mb-px -mr-px flex gap-4 border-b border-r border-border p-5 transition-colors hover:bg-muted/40"><span class="font-mono text-[12px] text-primary">${two(i)}</span><span><span class="block text-[15px] font-semibold text-foreground">${escapeHtml(s.title)}</span><span class="mt-1 block text-[13.5px] leading-6 text-muted-foreground">${escapeHtml(s.summary)}</span></span></a>`,
          )
          .join('')}</div>
        ${chapters}${faq}
        <p class="mt-20 border-t border-border pt-6 text-[13px] text-muted-foreground">${escapeHtml(chrome.updated)} ${options.updated}</p>
      </div>
    </main>
    <aside class="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 py-14 pr-6 xl:block"><p class="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">${content.lang === 'en' ? 'On this page' : '本章内容'}</p>${rail}</aside>
  </div>`
}

/* ───────────────────────────── B · 杂志 ───────────────────────────── */

const windowFrame = (inner: string) =>
  `<div class="overflow-hidden rounded-2xl border border-white/10 bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)] ring-1 ring-black/5"><div class="flex h-8 items-center gap-1.5 border-b border-border bg-muted/60 px-3"><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span><span class="h-2.5 w-2.5 rounded-full bg-foreground/15"></span></div><div class="relative">${inner}</div></div>`

const styleB: BlockStyle = {
  p: 'my-5 text-[16px] leading-[1.9] text-muted-foreground',
  list: 'my-5 space-y-3',
  listItem:
    'relative pl-6 text-[16px] leading-[1.85] text-muted-foreground before:absolute before:left-0 before:top-[0.55em] before:h-3 before:w-3 before:rounded-[4px] before:border before:border-primary/60 before:bg-primary/15',
  steps: (items) =>
    `<ol class="my-6 grid gap-3">${items
      .map(
        (item, i) =>
          `<li class="flex gap-5 rounded-2xl border border-border bg-card/60 px-5 py-4"><span class="font-display text-[28px] font-semibold leading-none tabular-nums text-primary">${two(i)}</span><div class="pt-1 text-[15.5px] leading-7 text-muted-foreground">${item}</div></li>`,
      )
      .join('')}</ol>`,
  callout: (tone, label, text) => {
    const box = {
      tip: 'border-primary/25 bg-primary/[0.07]',
      note: 'border-border bg-card/70',
      warn: 'border-warning/30 bg-warning/[0.07]',
    }[tone]
    const ic = { tip: 'text-primary', note: 'text-foreground/60', warn: 'text-warning' }[tone]
    return `<aside class="my-6 rounded-2xl border ${box} p-5"><p class="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider ${ic}">${icon(TONE_ICON[tone], 'h-4 w-4')}${label}</p><p class="mt-2 text-[15px] leading-7 text-muted-foreground">${text}</p></aside>`
  },
  shot: (img, caption, marks) =>
    `<figure class="my-10">${windowFrame(img + marks)}${caption ? `<figcaption class="mt-4 text-center text-[13px] tracking-wide text-muted-foreground">${caption}</figcaption>` : ''}</figure>`,
  mark: 'absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground shadow-[0_0_0_4px_hsl(var(--primary)/0.25)]',
  table: {
    wrap: 'my-6 overflow-hidden rounded-2xl border border-border',
    head: 'bg-card',
    th: 'px-5 py-3 text-[13px] font-semibold text-foreground',
    td: 'px-5 py-3.5 align-top text-[14.5px] leading-7 text-muted-foreground',
    row: 'border-t border-border even:bg-card/40',
  },
  cards: (items) =>
    `<div class="my-6 grid gap-3 sm:grid-cols-2">${items
      .map(
        (item) =>
          `<a href="${item.href ?? '#'}" class="group rounded-2xl border border-border bg-card/60 p-5 transition hover:-translate-y-0.5 hover:border-primary/40"><p class="text-[16px] font-semibold text-foreground">${item.title}</p><p class="mt-1.5 text-[14px] leading-6 text-muted-foreground">${item.text}</p><span class="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-primary">${content_learnMore}${icon(ArrowRight, 'h-3.5 w-3.5 transition group-hover:translate-x-0.5')}</span></a>`,
      )
      .join('')}</div>`,
  prompt: (label, text) =>
    `<figure class="my-6 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.08] to-transparent p-5"><figcaption class="text-[12px] font-semibold uppercase tracking-wider text-primary">${label}</figcaption><blockquote class="mt-2 text-[16px] leading-8 text-foreground" data-selectable-text>“${text}”</blockquote></figure>`,
}
// 杂志版卡片的「了解更多」随语言变，渲染时覆写。
let content_learnMore = '了解更多'

function variantB(content: GuideContent, options: PrototypeOptions): string {
  content_learnMore = content.lang === 'en' ? 'Read more' : '了解更多'
  const { chrome } = content
  const home = content.sections[0]!.subsections.find((s) => s.id === 'interface')!.blocks.find(
    (b) => b.type === 'shot',
  )
  const heroShot =
    home && home.type === 'shot'
      ? `<img src="${home.src}" alt="${escapeHtml(home.alt)}" class="block h-auto w-full" width="1440" height="900" />`
      : ''
  const chapterNav = content.sections
    .map(
      (s) =>
        `<a href="#${s.id}" data-toc="${s.id}" class="whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-[current=true]:bg-foreground aria-[current=true]:text-background">${escapeHtml(s.title)}</a>`,
    )
    .join('')
  const bento = [...content.sections, null]
    .map((s, i) => {
      const title = s ? s.title : content.faq.title
      const summary = s ? s.summary : content.faq.items[0]!.q
      const href = s ? s.id : content.faq.id
      const Ic = s ? sectionIcon(s) : CircleHelp
      return `<a href="#${href}" class="group relative overflow-hidden rounded-3xl border border-border bg-card/50 p-7 transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:bg-card"><span aria-hidden="true" class="pointer-events-none absolute -bottom-6 right-2 font-display text-[120px] font-bold leading-none text-foreground/[0.04] transition group-hover:text-primary/10">${two(i)}</span><span class="grid h-11 w-11 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">${icon(Ic, 'h-5 w-5')}</span><p class="mt-6 text-[19px] font-semibold text-foreground">${escapeHtml(title)}</p><p class="mt-2 max-w-[28ch] text-[14px] leading-6 text-muted-foreground">${escapeHtml(summary)}</p>${icon(ArrowUpRight, 'absolute right-6 top-7 h-5 w-5 text-muted-foreground transition group-hover:text-primary')}</a>`
    })
    .join('')
  const chapters = content.sections
    .map(
      (s, i) =>
        `<section class="relative border-t border-border py-28"><div class="mx-auto max-w-6xl px-6"><div class="mx-auto max-w-2xl text-center"><p class="font-mono text-[13px] tracking-[0.3em] text-primary">${two(i)}</p><h2 id="${s.id}" data-heading class="mt-4 scroll-mt-32 font-display text-[40px] font-semibold tracking-[-0.02em] text-foreground sm:text-[52px]">${escapeHtml(s.title)}</h2><p class="mt-4 text-[18px] leading-8 text-muted-foreground">${escapeHtml(s.summary)}</p></div>${
          s.intro
            ? `<div class="mx-auto mt-8 max-w-2xl text-center">${blocks(s.intro, styleB, content, options)}</div>`
            : ''
        }<div class="mt-16">${s.subsections
          .map(
            (sub, j) =>
              `<div class="grid gap-6 border-t border-dashed border-border py-14 first:border-t-0 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-16"><div><div class="lg:sticky lg:top-36"><p class="font-mono text-[12px] text-muted-foreground">${two(i)}.${j + 1}</p><h3 id="${sub.id}" data-heading class="mt-2 scroll-mt-32 text-[22px] font-semibold leading-snug tracking-tight text-foreground">${escapeHtml(sub.title)}</h3></div></div><div class="min-w-0 max-w-3xl [&>*:first-child]:mt-0">${blocks(sub.blocks, styleB, content, options)}</div></div>`,
          )
          .join('')}</div></div></section>`,
    )
    .join('')
  const faq = `<section class="border-t border-border py-28"><div class="mx-auto max-w-6xl px-6"><h2 id="${content.faq.id}" data-heading class="scroll-mt-32 text-center font-display text-[40px] font-semibold tracking-tight sm:text-[52px]">${escapeHtml(content.faq.title)}</h2><div class="mt-14 grid gap-4 md:grid-cols-2">${content.faq.items
    .map(
      (f) =>
        `<div class="rounded-2xl border border-border bg-card/50 p-6"><p class="text-[16px] font-semibold leading-7 text-foreground">${escapeHtml(f.q)}</p><p class="mt-2 text-[14.5px] leading-7 text-muted-foreground">${escapeHtml(f.a)}</p></div>`,
    )
    .join(
      '',
    )}</div><div class="proto-b-cta mt-20 overflow-hidden rounded-3xl border border-primary/25 px-8 py-14 text-center"><p class="font-display text-[32px] font-semibold tracking-tight">${content.lang === 'en' ? 'Ready to create?' : '准备好开始了吗？'}</p><a href="/" class="mt-6 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-[15px] font-semibold text-primary-foreground hover:opacity-90">${escapeHtml(chrome.start)}${icon(ArrowRight, 'h-4 w-4')}</a></div></div></section>`
  return `
  <header class="fixed inset-x-0 top-4 z-40 px-4">
    <div class="mx-auto flex h-12 max-w-5xl items-center gap-4 rounded-full border border-border bg-background/70 pl-4 pr-1.5 shadow-lg backdrop-blur-xl">
      <a href="/" class="flex items-center gap-2 text-[14px] font-semibold"><img src="/brand/muvloom-mark.svg" alt="" class="h-6 w-6" />${escapeHtml(chrome.brand)}</a>
      <span class="text-[13px] text-muted-foreground">${escapeHtml(chrome.title)}</span>
      <div class="ml-auto flex items-center gap-1">${languageLink(content, options, 'rounded-full px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground')}<a href="/" class="rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90">${escapeHtml(chrome.start)}</a></div>
    </div>
  </header>
  <main data-selectable-text>
    <section class="proto-b-hero relative overflow-hidden pb-10 pt-40 text-center">
      <div class="mx-auto max-w-3xl px-6">
        <span class="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-[12px] text-muted-foreground">${icon(Sparkles, 'h-3.5 w-3.5 text-primary')}${escapeHtml(chrome.eyebrow)}</span>
        <h1 class="mt-6 bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text font-display text-[52px] font-semibold leading-[1.05] tracking-[-0.03em] text-transparent sm:text-[76px]">${escapeHtml(chrome.title)}</h1>
        <p class="mx-auto mt-6 max-w-xl text-[18px] leading-8 text-muted-foreground">${renderInline(chrome.lead)}</p>
        <div class="mt-9 flex justify-center gap-3"><a href="#${content.sections[0]!.id}" class="rounded-full bg-foreground px-6 py-3 text-[14px] font-semibold text-background hover:opacity-90">${content.lang === 'en' ? 'Start reading' : '开始阅读'}</a><a href="/" class="rounded-full border border-border px-6 py-3 text-[14px] font-medium text-foreground hover:bg-muted">${escapeHtml(chrome.start)}</a></div>
      </div>
      <div class="proto-b-fade mx-auto mt-16 max-w-5xl px-6">${windowFrame(heroShot)}</div>
    </section>
    <section class="mx-auto max-w-6xl px-6 pb-24"><div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${bento}</div></section>
    <nav class="sticky top-[84px] z-30 flex justify-center px-4"><div class="flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-background/80 p-1 shadow-lg backdrop-blur-xl">${chapterNav}</div></nav>
    ${chapters}${faq}
  </main>`
}

/* ─────────────────────────── C · 帮助中心 ─────────────────────────── */

const styleC: BlockStyle = {
  p: 'my-4 text-[15px] leading-[1.85] text-muted-foreground',
  list: 'my-4 space-y-2',
  listItem:
    'relative pl-6 text-[15px] leading-[1.8] text-muted-foreground before:absolute before:left-1 before:top-[0.45em] before:h-3 before:w-3 before:rounded-full before:border-[3px] before:border-primary/35',
  steps: (items) =>
    `<ol class="relative my-6 ml-3 border-l-2 border-dashed border-primary/25">${items
      .map(
        (item, i) =>
          `<li class="relative pb-6 pl-8 last:pb-0"><span class="absolute -left-[15px] top-0 grid h-7 w-7 place-items-center rounded-full bg-primary text-[12px] font-bold text-primary-foreground ring-4 ring-card">${i + 1}</span><div class="pt-0.5 text-[15px] leading-7 text-muted-foreground">${item}</div></li>`,
      )
      .join('')}</ol>`,
  callout: (tone, label, text) => {
    const box = { tip: 'bg-primary/10', note: 'bg-secondary', warn: 'bg-warning/10' }[tone]
    const ic = {
      tip: 'bg-primary/20 text-primary',
      note: 'bg-background text-foreground/70',
      warn: 'bg-warning/20 text-warning',
    }[tone]
    return `<aside class="my-5 flex gap-3.5 rounded-xl ${box} p-4"><span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ic}">${icon(TONE_ICON[tone], 'h-4 w-4')}</span><div><p class="text-[13.5px] font-semibold text-foreground">${label}</p><p class="mt-0.5 text-[14.5px] leading-7 text-muted-foreground">${text}</p></div></aside>`
  },
  shot: (img, caption, marks) =>
    `<figure class="my-6 overflow-hidden rounded-xl border border-border bg-background"><div class="relative">${img}${marks}</div>${caption ? `<figcaption class="border-t border-border bg-muted/40 px-4 py-2.5 text-[13px] text-muted-foreground">${caption}</figcaption>` : ''}</figure>`,
  mark: 'absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-background bg-primary text-[11px] font-bold text-primary-foreground shadow-md',
  table: {
    wrap: 'my-5 overflow-x-auto rounded-xl border border-border',
    head: 'bg-muted/60',
    th: 'px-4 py-2.5 text-[13px] font-semibold text-foreground',
    td: 'px-4 py-3 align-top text-[14px] leading-7 text-muted-foreground',
    row: 'border-t border-border',
  },
  cards: (items) =>
    `<div class="my-5 grid gap-3 sm:grid-cols-3">${items
      .map(
        (item) =>
          `<a href="${item.href ?? '#'}" class="rounded-xl border border-border bg-background p-4 transition hover:border-primary/40 hover:shadow-md"><p class="text-[14.5px] font-semibold text-foreground">${item.title}</p><p class="mt-1 text-[13px] leading-6 text-muted-foreground">${item.text}</p></a>`,
      )
      .join('')}</div>`,
  prompt: (label, text) =>
    `<figure class="my-5 rounded-xl border border-border bg-background"><figcaption class="flex items-center gap-2 border-b border-border px-4 py-2 text-[12.5px] font-medium text-muted-foreground">${icon(WandSparkles, 'h-3.5 w-3.5 text-primary')}${label}</figcaption><blockquote class="px-4 py-3 text-[14.5px] leading-7 text-foreground" data-selectable-text>${text}</blockquote></figure>`,
}

function variantC(content: GuideContent, options: PrototypeOptions): string {
  const { chrome } = content
  const en = content.lang === 'en'
  const tiles = content.sections
    .map(
      (s) =>
        `<a href="#${s.id}" class="group flex flex-col rounded-2xl border border-border bg-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl"><span class="grid h-11 w-11 place-items-center rounded-xl bg-primary/12 text-primary">${icon(sectionIcon(s), 'h-5 w-5')}</span><p class="mt-5 text-[17px] font-semibold text-foreground">${escapeHtml(s.title)}</p><p class="mt-1.5 text-[14px] leading-6 text-muted-foreground">${escapeHtml(s.summary)}</p><ul class="mt-5 space-y-1.5 border-t border-border pt-4">${s.subsections
          .slice(0, 3)
          .map(
            (sub) =>
              `<li class="flex items-center gap-2 text-[13.5px] text-foreground/80">${icon(ArrowRight, 'h-3.5 w-3.5 text-primary')}${escapeHtml(sub.title)}</li>`,
          )
          .join(
            '',
          )}</ul><p class="mt-auto pt-5 text-[12.5px] text-muted-foreground">${en ? `${s.subsections.length} articles` : `共 ${s.subsections.length} 篇`}</p></a>`,
    )
    .join('')
  const sidebar = content.sections
    .map(
      (s) =>
        `<details data-toc-group="${s.id}" class="group/d"><summary class="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] font-medium text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden">${icon(sectionIcon(s), 'h-4 w-4 text-muted-foreground')}<a href="#${s.id}" data-toc="${s.id}" class="flex-1 aria-[current=true]:text-primary">${escapeHtml(s.title)}</a>${icon(ChevronDown, 'h-4 w-4 text-muted-foreground transition group-open/d:rotate-180')}</summary><ul class="mb-2 ml-5 mt-1 space-y-0.5 border-l border-border pl-3">${s.subsections
          .map(
            (sub) =>
              `<li><a href="#${sub.id}" data-toc="${sub.id}" data-toc-parent="${s.id}" class="block rounded-md px-2 py-1.5 text-[13.5px] text-muted-foreground hover:text-foreground aria-[current=true]:bg-primary/10 aria-[current=true]:font-medium aria-[current=true]:text-primary">${escapeHtml(sub.title)}</a></li>`,
          )
          .join('')}</ul></details>`,
    )
    .join('')
  const articles = content.sections
    .map(
      (s, i) =>
        `<section class="mt-14 first:mt-0"><div class="proto-c-banner flex items-start gap-5 rounded-2xl border border-border p-7"><span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">${icon(sectionIcon(s), 'h-7 w-7')}</span><div><p class="text-[12.5px] font-medium text-primary">${en ? `Chapter ${i + 1}` : `第 ${i + 1} 章`}</p><h2 id="${s.id}" data-heading class="mt-1 scroll-mt-28 text-[26px] font-semibold tracking-tight text-foreground">${escapeHtml(s.title)}</h2><p class="mt-1.5 text-[15px] leading-7 text-muted-foreground">${escapeHtml(s.summary)}</p></div></div>${
          s.intro ? `<div class="px-2">${blocks(s.intro, styleC, content, options)}</div>` : ''
        }${s.subsections
          .map(
            (sub) =>
              `<article class="mt-5 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8"><h3 id="${sub.id}" data-heading class="scroll-mt-28 text-[20px] font-semibold tracking-tight text-foreground">${escapeHtml(sub.title)}</h3><div class="[&>*:last-child]:mb-0">${blocks(sub.blocks, styleC, content, options)}</div></article>`,
          )
          .join('')}</section>`,
    )
    .join('')
  const faq = `<section class="mt-14"><h2 id="${content.faq.id}" data-heading class="scroll-mt-28 text-[26px] font-semibold tracking-tight">${escapeHtml(content.faq.title)}</h2><div class="mt-5 space-y-3">${content.faq.items
    .map(
      (f) =>
        `<details class="group rounded-xl border border-border bg-card px-5 py-4 shadow-sm open:shadow-md"><summary class="flex cursor-pointer list-none items-center gap-3 text-[15px] font-medium text-foreground [&::-webkit-details-marker]:hidden">${icon(CircleHelp, 'h-4.5 h-[18px] w-[18px] shrink-0 text-primary')}<span class="flex-1">${escapeHtml(f.q)}</span>${icon(ChevronDown, 'h-4 w-4 text-muted-foreground transition group-open:rotate-180')}</summary><p class="mt-2 pl-[30px] text-[14.5px] leading-7 text-muted-foreground">${escapeHtml(f.a)}</p></details>`,
    )
    .join('')}</div></section>`
  const hot = content.faq.items
    .slice(0, 4)
    .map(
      (f) =>
        `<a href="#${content.faq.id}" class="rounded-full border border-border bg-background/70 px-3 py-1 text-[12.5px] text-muted-foreground backdrop-blur hover:border-primary/40 hover:text-foreground">${escapeHtml(f.q.replace(/[？?]$/, ''))}</a>`,
    )
    .join('')
  return `
  <header class="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur-xl">
    <div class="mx-auto flex h-16 max-w-6xl items-center gap-3 px-6">
      <a href="/" class="flex items-center gap-2.5 text-[16px] font-semibold"><img src="/brand/muvloom-mark.svg" alt="" class="h-7 w-7" />${escapeHtml(chrome.brand)}</a>
      <span class="h-5 w-px bg-border"></span><span class="text-[14px] text-muted-foreground">${escapeHtml(chrome.eyebrow)}</span>
      <div class="ml-auto flex items-center gap-2">${languageLink(content, options, 'rounded-lg px-3 py-2 text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground')}<a href="/" class="rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90">${escapeHtml(chrome.start)}</a></div>
    </div>
  </header>
  <main data-selectable-text>
    <section class="proto-c-hero border-b border-border">
      <div class="mx-auto max-w-3xl px-6 pb-24 pt-20 text-center">
        <h1 class="text-[40px] font-semibold tracking-tight text-foreground sm:text-[48px]">${escapeHtml(chrome.title)}</h1>
        <p class="mt-3 text-[17px] text-muted-foreground">${renderInline(chrome.lead)}</p>
        <div class="relative mx-auto mt-9 max-w-2xl text-left" data-search>
          <label class="flex h-14 items-center gap-3 rounded-2xl border border-border bg-background px-5 shadow-xl shadow-black/10 focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">${icon(Search, 'h-5 w-5 text-muted-foreground')}<input data-search-input type="search" autocomplete="off" placeholder="${en ? 'Search features, e.g. inpainting, slots, shortcuts' : '搜索功能，例如 局部重绘、批量生成、快捷键'}" class="h-full flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground" /></label>
          <div data-search-results hidden class="absolute inset-x-0 top-[62px] z-20 max-h-80 overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl"></div>
        </div>
        <div class="mt-6 flex flex-wrap items-center justify-center gap-2"><span class="text-[12.5px] text-muted-foreground">${en ? 'Popular:' : '热门问题：'}</span>${hot}</div>
      </div>
    </section>
    <section class="mx-auto -mt-12 max-w-6xl px-6"><div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">${tiles}</div></section>
    <div class="mx-auto mt-20 grid max-w-6xl gap-10 px-6 pb-32 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside class="hidden lg:block"><nav class="sticky top-24 max-h-[calc(100vh-7rem)] space-y-1 overflow-y-auto">${sidebar}<a href="#${content.faq.id}" data-toc="${content.faq.id}" class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] font-medium text-foreground hover:bg-muted aria-[current=true]:text-primary">${icon(CircleHelp, 'h-4 w-4 text-muted-foreground')}${escapeHtml(content.faq.title)}</a></nav></aside>
      <div class="min-w-0">${articles}${faq}
        <div class="mt-14 flex flex-col items-start gap-4 rounded-2xl border border-border bg-card p-7 sm:flex-row sm:items-center"><div class="flex-1"><p class="text-[17px] font-semibold">${en ? 'Still have questions?' : '没有找到答案？'}</p><p class="mt-1 text-[14px] text-muted-foreground">${en ? 'Try it in the studio — most features explain themselves once you see them.' : '打开工作台亲自试试，大部分功能上手即会。'}</p></div><a href="/" class="rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-primary-foreground">${escapeHtml(chrome.start)}</a></div>
      </div>
    </div>
  </main>`
}

const RENDERERS: Record<VariantKey, (content: GuideContent, options: PrototypeOptions) => string> =
  {
    A: variantA,
    B: variantB,
    C: variantC,
  }

export function renderPrototypeDocument(
  content: GuideContent,
  variant: VariantKey,
  options: PrototypeOptions,
): string {
  return `<!DOCTYPE html>
<html lang="${content.lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <title>[PROTOTYPE ${variant}] ${escapeHtml(content.meta.title)}</title>
    <link rel="icon" href="/brand/muvloom-icon.svg" type="image/svg+xml" />
  </head>
  <body class="proto-${variant.toLowerCase()} min-h-screen bg-background font-sans text-foreground antialiased" data-variant="${variant}" data-variants="${Object.entries(
    VARIANTS,
  )
    .map(([key, name]) => `${key}:${name}`)
    .join(',')}">
    ${RENDERERS[variant](content, options)}
    <script type="module" src="/src/features/guide/prototype/client.ts"></script>
  </body>
</html>
`
}
