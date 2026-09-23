/**
 * 使用指南的内容模型。指南在构建期渲染成静态 HTML（搜索引擎直接读到正文），
 * 所以内容是纯数据而不是组件：每种语言一份，结构完全相同，由 `render.ts` 统一出页面。
 *
 * 行内标记（`Inline`）只认四种，先转义再替换，内容里不能写 HTML：
 * - `**重点**` → 加粗
 * - `[[生成]]` → 界面上的按钮 / 标签原文，渲染成胶囊，读者照着找
 * - `{{Ctrl}}` → 键盘按键
 * - `[文字](/explore)` → 链接；只收站内路径、`#锚点` 与 https 地址
 */
export type Inline = string

export type Block =
  | { type: 'p'; text: Inline }
  | { type: 'steps'; items: Inline[] }
  | { type: 'list'; items: Inline[] }
  | { type: 'callout'; tone: 'tip' | 'note' | 'warn'; text: Inline }
  | { type: 'shot'; src: string; alt: string; caption?: Inline; marks?: ShotMark[] }
  | { type: 'table'; head: Inline[]; rows: Inline[][] }
  | { type: 'cards'; items: { title: Inline; text: Inline; href?: string }[] }
  | { type: 'prompt'; label: Inline; text: string }

/** 截图上的编号圆点，坐标是占图片宽高的百分比；图下的步骤或列表按同样的编号讲解。 */
export interface ShotMark {
  x: number
  y: number
}

export interface GuideSubsection {
  id: string
  title: string
  blocks: Block[]
}

export interface GuideSection {
  id: string
  title: string
  /** 一句话概述，用于目录卡片与章节导语。 */
  summary: string
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
  /** 本语言版本的站内地址，以 `/` 结尾。 */
  path: string
  meta: { title: string; description: string; ogImageAlt: string }
  chrome: {
    brand: string
    eyebrow: string
    title: string
    lead: string
    start: string
    toc: string
    tipLabel: string
    noteLabel: string
    warnLabel: string
    backToTop: string
    otherLanguage: string
    updated: string
  }
  sections: GuideSection[]
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
export const cards = (...items: { title: Inline; text: Inline; href?: string }[]): Block => ({
  type: 'cards',
  items,
})
export const prompt = (label: Inline, text: string): Block => ({ type: 'prompt', label, text })
