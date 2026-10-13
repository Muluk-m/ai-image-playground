import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * 浏览页的页头：最低 56px，窄窗口放不下时换行。宽屏右侧按浮动账号簇的实际宽度让位
 * （`--studio-header-actions-width` 由 Header 测量写入）。窄屏账号簇在顶栏里，页头不再让位。
 * `leading` 放在标题前（返回按钮、面包屑）。
 */
export default function PageHeader({
  title,
  leading,
  children,
  className,
}: {
  title?: ReactNode
  leading?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b py-2.5 border-border pl-4 pr-4 md:pl-6 md:pr-[max(1.5rem,calc(var(--studio-header-actions-width,0px)+2rem))]',
        className,
      )}
    >
      {leading}
      {title != null ? (
        <h1 className="inline-flex shrink-0 items-center gap-2 font-display text-title font-semibold">
          {title}
        </h1>
      ) : null}
      {children}
    </div>
  )
}
