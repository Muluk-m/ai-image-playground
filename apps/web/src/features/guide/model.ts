/**
 * 使用指南的内容模型。指南在构建期渲染成静态 HTML（搜索引擎直接读到正文），
 * 所以内容是纯数据而不是组件：每种语言一份，结构完全相同，由 `render.ts` 统一出页面。
 * 一份内容出一个首页（`root`）加每章一页（`root + chapter.id + '/'`）。
 *
 * 行内标记（`Inline`）只认这几种，先转义再替换，内容里不能写 HTML：
 * - `**重点**` → 加粗
 * - `[[生成]]` → 界面上的按钮 / 标签原文，渲染成胶囊
 * - `{{Ctrl}}` → 键盘按键
 * - `` `@` `` → 代码
 * - `[文字](/guide/canvas/#canvas-basics)` → 链接；只收站内路径、`#锚点` 与 https 地址
 */
export type Inline = string

export type Block =
  | { type: 'p'; text: Inline }
  | { type: 'steps'; items: Inline[] }
  | { type: 'list'; items: Inline[] }
  | { type: 'callout'; tone: 'tip' | 'note' | 'warn'; text: Inline }
  | { type: 'shot'; src: string; alt: string; caption?: Inline; marks?: ShotMark[] }
  | { type: 'table'; head: Inline[]; rows: Inline[][] }
  | { type: 'prompt'; label: Inline; text: string }

/** 截图上的编号圆点，坐标是占图片宽高的百分比；图下的步骤或列表按同样的编号讲解。 */
export interface ShotMark {
  x: number
  y: number
}

export interface GuideSubsection {
  /** 页内锚点，全站唯一（搜索结果与跨章链接直接用它）。 */
  id: string
  title: string
  blocks: Block[]
}

export interface GuideChapter {
  /** 地址段：`/guide/<id>/`。两种语言相同。 */
  id: string
  title: string
  /** 一句话概述，用于首页章节卡片与章节导语。 */
  summary: string
  /** 本章独立页面的搜索结果标题与描述。 */
  meta: { title: string; description: string }
  intro?: Block[]
  subsections: GuideSubsection[]
}

export interface GuideFaq {
  q: string
  /** 纯文本：同一份答案还要写进 FAQPage 结构化数据。 */
  a: string
}

export interface GuideContent {
  /** `<html lang>` 与 hreflang 用的语言标签。 */
  lang: 'zh-CN' | 'en'
  /** 本语言指南首页的站内地址，以 `/` 结尾。 */
  root: string
  /** 首页的搜索结果标题与描述。 */
  meta: { title: string; description: string; ogImageAlt: string }
  chrome: {
    brand: string
    eyebrow: string
    title: string
    lead: string
    start: string
    startReading: string
    chaptersTitle: string
    ctaTitle: string
    /** 章节序号，`{n}` 换成两位数字。 */
    chapterLabel: string
    toc: string
    onThisPage: string
    prev: string
    next: string
    search: string
    searchPlaceholder: string
    searchEmpty: string
    copy: string
    copied: string
    tipLabel: string
    noteLabel: string
    warnLabel: string
    otherLanguage: string
    updated: string
  }
  home: { image: string; imageAlt: string }
  chapters: GuideChapter[]
  faq: { id: string; title: string; items: GuideFaq[] }
}

export const p = (text: Inline): Block => ({ type: 'p', text })
export const steps = (...items: Inline[]): Block => ({ type: 'steps', items })
export const list = (...items: Inline[]): Block => ({ type: 'list', items })
export const tip = (text: Inline): Block => ({ type: 'callout', tone: 'tip', text })
export const note = (text: Inline): Block => ({ type: 'callout', tone: 'note', text })
export const warn = (text: Inline): Block => ({ type: 'callout', tone: 'warn', text })
export const shot = (src: string, alt: string, caption?: Inline, marks?: ShotMark[]): Block => ({
  type: 'shot',
  src,
  alt,
  caption,
  marks,
})
export const table = (head: Inline[], ...rows: Inline[][]): Block => ({ type: 'table', head, rows })
export const prompt = (label: Inline, text: string): Block => ({ type: 'prompt', label, text })
