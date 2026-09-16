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

export const PANEL_SURFACE = 'border border-[var(--studio-border)] bg-[var(--studio-panel)]'

export const PANEL_SHADOW = 'shadow-[var(--studio-shadow)]'

export const INK = 'text-[var(--studio-text)]'
export const INK_3 = 'text-[var(--studio-muted)]'

export const TAB = 'pb-1 text-xs transition-colors'
export const ACTIVE_TAB = `${INK} border-b-[1.5px] border-current font-semibold`
export const IDLE_TAB = `${INK_3} hover:text-[var(--studio-text)]`

export const USER_BUBBLE = `max-w-[86%] self-end rounded-xl bg-[var(--studio-raised)] px-2.5 py-1.5 text-xs leading-relaxed ${INK}`

export const REPLY = 'max-w-full text-xs leading-relaxed text-[var(--studio-text-secondary)]'

export const FIELD =
  'w-full resize-none rounded-xl border border-[var(--studio-border)] bg-[var(--studio-raised)] px-2.5 py-2 text-xs text-[var(--studio-text)] placeholder:text-[var(--studio-muted)] focus:border-[var(--studio-accent)] focus:outline-none'

export const SEND_BUTTON =
  'h-9 rounded-lg bg-[var(--studio-accent)] text-[var(--studio-on-accent)] px-3 text-xs font-semibold transition hover:bg-[var(--studio-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40'

export const ABORT_BUTTON =
  'h-7 rounded-lg border border-[var(--studio-border)] px-3 text-xs text-[var(--studio-text-secondary)] transition hover:bg-[var(--studio-raised)]'

export const ICON_BUTTON = `rounded-lg p-1 transition-colors ${INK_3} hover:bg-[var(--studio-raised)] hover:text-[var(--studio-text)]`

export const LIST_ROW =
  'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--studio-raised)]'

export const ACTIVE_LIST_ROW = 'bg-[var(--studio-raised)]'

export const GHOST_LINK =
  'text-[11px] text-[var(--studio-accent)] transition-colors hover:text-[var(--studio-accent)]'

export const CARD =
  'flex max-w-full flex-col gap-1.5 rounded-xl border border-[var(--studio-border)] bg-[var(--studio-raised)] px-2.5 py-2'

export const CARD_TITLE = `text-xs leading-relaxed ${INK}`

export const CARD_NOTE = `text-[11px] ${INK_3}`

export const CHOICE =
  'w-full rounded-lg border border-[var(--studio-border)] px-2.5 py-1.5 text-left text-xs text-[var(--studio-text)] transition enabled:hover:border-[var(--studio-accent)] enabled:hover:bg-[var(--studio-raised)] disabled:cursor-not-allowed disabled:opacity-45'

/** 产出缩略图的底座。不在画布上的那些点了也定位不到，用这个不带悬停反馈的版本。 */
export const THUMBNAIL_STATIC =
  'relative block h-16 w-16 overflow-hidden rounded-lg border border-[var(--studio-border)]'

export const THUMBNAIL = `${THUMBNAIL_STATIC} transition hover:border-[var(--studio-accent)]`
