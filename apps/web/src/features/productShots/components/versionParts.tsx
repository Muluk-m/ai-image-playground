import type { ReactNode, SVGProps } from 'react'
import { actionLabel } from '../lib/actions'
import { matteBadge } from '../lib/matteBadge'
import { VERSION_STATE_LABELS, type VersionState } from '../lib/versionProgress'
import type { ProductShotVersion } from '../types'
import BadgeTag from './BadgeTag'

/** 图标操作行：指针悬停或键盘聚焦才露出，触摸屏没有 hover，常显。 */
export const VERSION_ACTION_ROW =
  'flex flex-wrap items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100'

export const VERSION_ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100'

const AMBER_TAG = 'shrink-0 rounded bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300'

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  )
}

export function PlanIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9h6m-6 4h4"
      />
    </svg>
  )
}

export function MatteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3l9 5-9 5-9-5 9-5zm9 9l-9 5-9-5m18 4l-9 5-9-5"
      />
    </svg>
  )
}

export function RetryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.7-2.7M4 15a8 8 0 0014.7 2.7"
      />
    </svg>
  )
}

export function MaskRetryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3l9 5-9 5-9-5 9-5zM4 14v4h4m12 2v-4h-4m3.2 0a6 6 0 01-9.8 2.2M4.8 16a6 6 0 019.8-2.2"
      />
    </svg>
  )
}

/** 「第 N 版 · 动作」一行不换行；`trailing` 给读秒或耗时。版本条与总览卡共用。 */
export function VersionTitle({
  index,
  version,
  trailing,
  truncateAction = true,
}: {
  index: number
  version: ProductShotVersion
  trailing?: ReactNode
  /** 总览卡的格子窄，动作标签放不下就省略；版本条宽，整个放出来。 */
  truncateAction?: boolean
}) {
  return (
    <span
      data-product-shots-version-title
      className="flex items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-gray-700 dark:text-gray-200"
    >
      <span className="shrink-0 font-medium">第 {index + 1} 版</span>
      <span
        className={`rounded bg-violet-500/10 px-1 text-[11px] text-violet-700 dark:text-violet-300 ${
          truncateAction ? 'truncate' : 'shrink-0'
        }`}
      >
        {actionLabel(version.mode, version.level)}
      </span>
      {trailing}
    </span>
  )
}

/** 状态标签排成小字，放不下换行而不是挤扁。`state` 省掉时由调用方自己报进度。 */
export function VersionTags({
  version,
  state,
}: {
  version: ProductShotVersion
  state?: VersionState
}) {
  return (
    <span
      data-product-shots-version-tags
      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400"
    >
      {state !== undefined && state !== 'done' && (
        <span className="shrink-0">{VERSION_STATE_LABELS[state]}</span>
      )}
      {/* 「未抠图 · 运行错误」比别的标签长，独占一行还放不下才省略。 */}
      <BadgeTag badge={matteBadge(version)} className="min-w-0 truncate px-1" />
      {version.lowResSource && <span className={AMBER_TAG}>源图分辨率低</span>}
      {version.promptEdited && <span className={AMBER_TAG}>手改</span>}
    </span>
  )
}
