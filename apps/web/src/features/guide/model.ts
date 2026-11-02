/**
 * 使用指南的内容模型。指南在构建期渲染成静态 HTML（搜索引擎直接读到正文），
 * 所以内容是纯数据而不是组件：每种语言一份，由 `apps/website` 的 React 组件统一出页面。
 *
 * 结构是「分组 → 页面」：每个页面一个功能，地址为 `root + group.id + '/' + page.id + '/'`。
 * 页面固定按「功能简介 → 操作步骤（编号截图 / 短录屏）→ 关键参数 → 说明与限制 → 相关文档」组织。
 * 改版前的章节地址写在 `moved` 里，构建时生成跳转页，旧链接与锚点不会 404。
 *
 * 行内标记（`Inline`）只认这几种，先转义再替换，内容里不能写 HTML：
 * - `**重点**` → 加粗
 * - `[[生成]]` → 界面上的按钮 / 标签原文
 * - `{{Ctrl}}` → 键盘按键
 * - `` `@` `` → 代码
 * - `[文字](/guide/canvas/basics/#canvas-tools)` → 链接；只收站内路径、`#锚点`、https 与 mailto 地址
 */
export type Inline = string

export type Block =
  | { type: 'p'; text: Inline }
  | { type: 'steps'; items: Inline[]; shot?: ShotBlock }
  | { type: 'list'; items: Inline[] }
  | { type: 'callout'; tone: 'tip' | 'note' | 'warn'; text: Inline }
  | ShotBlock
  | VideoBlock
  | { type: 'table'; head: Inline[]; rows: Inline[][] }
  | { type: 'prompt'; label: Inline; text: string }
  | { type: 'faq'; items: GuideFaq[] }

/**
 * 截图。`marks` 是图上的编号圆点，坐标是占图片宽高的百分比；编号默认按顺序 1、2、3…，
 * 与同一组步骤的编号一一对应。`width` 是展示宽度上限（CSS px），用于弹层这类窄截图：
 * 带截图的步骤在宽屏上会把窄截图放在步骤右侧。
 */
export interface ShotBlock {
  type: 'shot'
  src: string
  alt: string
  caption?: Inline
  marks?: ShotMark[]
  width?: number
}
export interface ShotMark {
  x: number
  y: number
  /** 圆点上的文字，默认是序号。 */
  label?: string
}
/** 几秒的无声循环录屏。进入视口才加载播放；系统开启「减少动态效果」时只显示封面与播放控件。 */
export interface VideoBlock {
  type: 'video'
  /** mp4（H.264），所有浏览器都能播。 */
  src: string
  /** 可选的 WebM，体积更小时优先。 */
  webm?: string
  poster: string
  alt: string
  caption?: Inline
  width: number
  height: number
}

export interface GuideSubsection {
  /** 页内锚点，全站唯一（搜索结果与跳转页直接用它）。 */
  id: string
  title: string
  blocks: Block[]
}

export interface GuidePage {
  /** 地址段：`/guide/<group>/<id>/`。 */
  id: string
  title: string
  /** 一句话简介：页首导语、首页目录与搜索结果都用它。 */
  summary: string
  /** 本页的搜索结果标题与描述。 */
  meta: { title: string; description: string }
  /** 内容最后核对日期，`YYYY-MM-DD`。 */
  updated: string
  intro?: Block[]
  sections: GuideSubsection[]
  /** 相关文档，写 `group/page`。 */
  related?: string[]
}

export interface GuideGroup {
  id: string
  title: string
  pages: GuidePage[]
}

export interface GuideFaq {
  q: string
  /** 纯文本：同一份答案还要写进 FAQPage 结构化数据。 */
  a: string
}

/** 改版前的地址（相对 root，如 `create/`）→ 新页面；`anchors` 把旧锚点带到新页面的对应位置。 */
export interface GuideMoved {
  to: string
  anchors?: Record<string, string>
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
    title: string
    lead: string
    toc: string
    onThisPage: string
    prev: string
    next: string
    related: string
    search: string
    searchEmpty: string
    tipLabel: string
    noteLabel: string
    warnLabel: string
    updated: string
    /** `{n}` 换成分钟数。 */
    readingTime: string
    movedTitle: string
    movedBody: string
  }
  groups: GuideGroup[]
  moved: Record<string, GuideMoved>
}

export interface GuideEntry {
  group: GuideGroup
  page: GuidePage
  /** `group/page` */
  key: string
  path: string
}

/** 按目录顺序列出全部页面（上一篇 / 下一篇、站点清单与搜索共用）。 */
export function guideEntries(guide: GuideContent): GuideEntry[] {
  return guide.groups.flatMap((group) =>
    group.pages.map((page) => ({
      group,
      page,
      key: `${group.id}/${page.id}`,
      path: `${guide.root}${group.id}/${page.id}/`,
    })),
  )
}

/** 页面里的全部块，含页首导语与步骤里附带的截图。 */
export function pageBlocks(page: GuidePage): Block[] {
  return [...(page.intro ?? []), ...page.sections.flatMap((section) => section.blocks)].flatMap(
    (block) => (block.type === 'steps' && block.shot ? [block, block.shot] : [block]),
  )
}

export const p = (text: Inline): Block => ({ type: 'p', text })
export const steps = (...items: Inline[]): Block => ({ type: 'steps', items })
/** 带截图的步骤：截图上的编号与步骤序号对应。 */
export const stepsWith = (shot: ShotBlock, ...items: Inline[]): Block => ({
  type: 'steps',
  items,
  shot,
})
export const list = (...items: Inline[]): Block => ({ type: 'list', items })
export const tip = (text: Inline): Block => ({ type: 'callout', tone: 'tip', text })
export const note = (text: Inline): Block => ({ type: 'callout', tone: 'note', text })
export const warn = (text: Inline): Block => ({ type: 'callout', tone: 'warn', text })
export const shot = (
  src: string,
  alt: string,
  caption?: Inline,
  marks?: ShotMark[],
  width?: number,
): ShotBlock => ({ type: 'shot', src, alt, caption, marks, width })
export const video = (input: Omit<VideoBlock, 'type'>): Block => ({ type: 'video', ...input })
export const table = (head: Inline[], ...rows: Inline[][]): Block => ({ type: 'table', head, rows })
export const prompt = (label: Inline, text: string): Block => ({ type: 'prompt', label, text })
export const faq = (...items: GuideFaq[]): Block => ({ type: 'faq', items })
