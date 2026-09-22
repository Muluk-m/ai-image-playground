/** 面板默认宽度，也是能拖到的最窄。 */
export const PANEL_WIDTH = 340
/** 最宽拖到视口的六成：再宽画布就没地方了。 */
export const PANEL_MAX_WIDTH_RATIO = 0.6

export function clampPanelWidth(
  width: number,
  viewportWidth: number = globalThis.innerWidth || Number.POSITIVE_INFINITY,
): number {
  const max = Math.max(PANEL_WIDTH, Math.floor(viewportWidth * PANEL_MAX_WIDTH_RATIO))
  return Math.min(max, Math.max(PANEL_WIDTH, Math.round(width)))
}

export const PANEL_SURFACE = 'border border-border bg-sidebar'

export const PANEL_SHADOW = 'shadow-[var(--studio-shadow)]'

export const INK = 'text-foreground'
export const INK_3 = 'text-muted-foreground'

// 段控风格：有底的胶囊比下划线更容易看出当前档，也和右上角账号簇的 chip 同一套。
export const TAB = 'rounded-lg px-3 py-1.5 text-xs transition-colors'
export const ACTIVE_TAB = `${INK} bg-muted font-semibold`
export const IDLE_TAB = `${INK_3} hover:bg-muted/60 hover:text-foreground`

export const USER_BUBBLE = `max-w-[86%] self-end rounded-xl bg-muted px-2.5 py-1.5 text-xs leading-relaxed ${INK}`

export const REPLY = 'max-w-full text-xs leading-relaxed text-foreground'

/** 回复下方的操作键：悬停或键盘聚焦时才出现；没有悬停的触屏上常驻。 */
export const REPLY_ACTION =
  'inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'

/** 离开底部时浮在对话记录下沿的「有新消息」。 */
export const JUMP_TO_LATEST =
  'absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-[11px] text-foreground shadow-[var(--studio-shadow)] transition hover:bg-muted'

export const FIELD =
  'w-full resize-none rounded-xl border border-border bg-muted px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none'

export const SEND_BUTTON =
  'h-9 rounded-lg bg-primary text-primary-foreground px-3 text-xs font-semibold transition hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40'

export const ABORT_BUTTON =
  'h-8 min-w-12 shrink-0 whitespace-nowrap rounded-lg border border-border px-3 text-xs text-foreground transition hover:bg-muted'

export const ICON_BUTTON = `rounded-lg p-1 transition-colors ${INK_3} hover:bg-muted hover:text-foreground`

export const LIST_ROW =
  'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted'

export const ACTIVE_LIST_ROW = 'bg-muted'

export const GHOST_LINK = 'text-[11px] text-primary transition-colors hover:text-primary'

export const CARD =
  'flex max-w-full flex-col gap-1.5 rounded-xl border border-border bg-muted px-2.5 py-2'

export const CARD_TITLE = `text-xs leading-relaxed ${INK}`

export const CARD_NOTE = `text-[11px] ${INK_3}`

/**
 * 草稿卡里那块提示词：卡本身是 `bg-muted`，输入框用底色分出来，一眼看得出这段字可以改。
 * 高度由内容给，长到放不下再滚动。
 */
export const DRAFT_FIELD =
  'w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-45'

export const CHOICE =
  'w-full rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-foreground transition enabled:hover:border-primary enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45'

/** 澄清卡片里「其他」的输入框与发送键，和选项同高，读起来还是一列。 */
export const CHOICE_FIELD =
  'min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-45'

export const CHOICE_SUBMIT =
  'shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-40'

/** 产出缩略图的底座。不在画布上的那些点了也定位不到，用这个不带悬停反馈的版本。 */
export const THUMBNAIL_STATIC =
  'relative block h-16 w-16 overflow-hidden rounded-lg border border-border'

export const THUMBNAIL = `${THUMBNAIL_STATIC} transition hover:border-primary`
