/** 画布容器在任何主题下都是 `#101011`，所以这套色恒定深色，不复用跟随主题的 panelStyles。 */

export const PANEL_WIDTH = 270
export const PANEL_MARGIN = 10

export const PANEL_SURFACE = 'border border-white/[0.09] bg-[#17171a]'

export const PANEL_SHADOW = 'shadow-[0_18px_60px_rgba(0,0,0,0.55)]'

export const INK = 'text-[#e8e8ea]'
export const INK_3 = 'text-[#5f5f68]'

export const TAB = 'pb-1 text-xs transition-colors'
export const ACTIVE_TAB = `${INK} border-b-[1.5px] border-current font-semibold`
export const IDLE_TAB = `${INK_3} hover:text-[#8b8b93]`

export const USER_BUBBLE = `max-w-[86%] self-end rounded-xl bg-white/[0.09] px-2.5 py-1.5 text-xs leading-relaxed ${INK}`

export const REPLY = 'max-w-full text-xs leading-relaxed text-[#c9c9d0]'

export const FIELD =
  'w-full resize-none rounded-xl border border-white/[0.09] bg-white/[0.05] px-2.5 py-2 text-xs text-[#e8e8ea] placeholder:text-[#5f5f68] focus:border-blue-500/50 focus:outline-none'

export const SEND_BUTTON =
  'h-7 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40'

export const ABORT_BUTTON =
  'h-7 rounded-lg border border-white/[0.12] px-3 text-xs text-[#c9c9d1] transition hover:bg-white/[0.08]'

export const ICON_BUTTON = `rounded-lg p-1 transition-colors ${INK_3} hover:bg-white/[0.08] hover:text-[#e8e8ea]`

export const LIST_ROW =
  'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06]'

export const ACTIVE_LIST_ROW = 'bg-white/[0.09]'

export const GHOST_LINK = 'text-[11px] text-blue-300 transition-colors hover:text-blue-200'

export const CARD =
  'flex max-w-full flex-col gap-1.5 rounded-xl border border-white/[0.09] bg-white/[0.04] px-2.5 py-2'

export const CARD_TITLE = `text-xs leading-relaxed ${INK}`

export const CARD_NOTE = `text-[11px] ${INK_3}`

export const CHOICE =
  'w-full rounded-lg border border-white/[0.12] px-2.5 py-1.5 text-left text-xs text-[#e8e8ea] transition enabled:hover:border-blue-500/60 enabled:hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45'

export const THUMBNAIL =
  'h-16 w-16 overflow-hidden rounded-lg border border-white/[0.09] transition hover:border-blue-500/60'
