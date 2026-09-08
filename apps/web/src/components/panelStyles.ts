export const CARD =
  'rounded-2xl border border-gray-200/70 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]'

const FIELD_BASE =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100'

export const FIELD = `${FIELD_BASE} focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/15`

/** 装 chip 的输入框：焦点环跟着框里的 input 走，`focus:` 挂在容器上不会触发。 */
export const FIELD_BOX = `${FIELD_BASE} flex flex-wrap items-center gap-1.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:border-blue-500/50 dark:focus-within:ring-blue-500/15`

export const LABEL = 'text-xs font-medium text-gray-500 dark:text-gray-400'

/** 面板与面板内分段的标题。 */
export const PANEL_TITLE = 'text-sm font-semibold text-gray-800 dark:text-gray-100'

/** 同一张卡里分段之间的分隔。 */
export const PANEL_SECTION = 'border-t border-gray-200/70 pt-4 dark:border-white/[0.08]'

export const PRIMARY_BUTTON =
  'rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-wait disabled:opacity-60'

export const NOTICE =
  'rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'

export const OUTLINE_BUTTON =
  'rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.12] dark:text-gray-200 dark:hover:border-blue-500/50 dark:hover:text-blue-300'

export const GHOST_BUTTON =
  'rounded-lg px-2 py-1 text-xs text-blue-600 transition hover:bg-blue-500/10 disabled:opacity-40 dark:text-blue-300'

export const SELECT =
  'rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-800 focus:border-blue-400 focus:outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100'

/** 分段控件的一格，选中时叠 `ACTIVE_SEGMENT`，否则叠 `IDLE_SEGMENT`。 */
export const SEGMENT = 'rounded-md px-2.5 py-1 text-xs transition'

export const ACTIVE_SEGMENT =
  'bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-50'

export const IDLE_SEGMENT = 'text-gray-500 disabled:opacity-50 dark:text-gray-400'

/** 顶栏是 fixed 的，吸顶元素得自己让开它加上刘海的高度。 */
export const HEADER_OFFSET = 'calc(var(--safe-area-top) + var(--header-height))'
