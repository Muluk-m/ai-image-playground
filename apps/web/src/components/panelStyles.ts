export const CARD = 'rounded-2xl border border-border/70 bg-card/70 p-4 dark:border-white/[0.08]'

const FIELD_BASE =
  'w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground dark:border-white/[0.08]'

export const FIELD = `${FIELD_BASE} focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring`

/** 装 chip 的输入框：焦点环跟着框里的 input 走，`focus:` 挂在容器上不会触发。 */
export const FIELD_BOX = `${FIELD_BASE} flex flex-wrap items-center gap-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring`

export const LABEL = 'text-xs font-medium text-muted-foreground'

/** 面板与面板内分段的标题。 */
export const PANEL_TITLE = 'text-sm font-semibold text-foreground'

/** 同一张卡里分段之间的分隔。 */
export const PANEL_SECTION = 'border-t border-border/70 pt-4 dark:border-white/[0.08]'

export const PRIMARY_BUTTON =
  'rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60'

export const NOTICE = 'rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning dark:text-warning'

export const OUTLINE_BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition hover:border-primary hover:text-primary dark:border-white/[0.12]'

export const GHOST_BUTTON =
  'rounded-lg px-2 py-1 text-xs text-primary transition hover:bg-primary/10 disabled:opacity-40'

export const SELECT =
  'rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none dark:border-white/[0.08]'

/** 分段控件的一格，选中时叠 `ACTIVE_SEGMENT`，否则叠 `IDLE_SEGMENT`。 */
export const SEGMENT = 'rounded-md px-2.5 py-1 text-xs transition'

export const ACTIVE_SEGMENT = 'bg-card font-medium text-foreground shadow-sm'

export const IDLE_SEGMENT = 'text-muted-foreground disabled:opacity-50'

/** 顶栏是 fixed 的，吸顶元素得自己让开它加上刘海的高度。 */
export const HEADER_OFFSET = 'calc(var(--safe-area-top) + var(--header-height))'
