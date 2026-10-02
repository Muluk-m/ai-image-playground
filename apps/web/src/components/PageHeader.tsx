import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

/**
 * 浏览页的页头：固定 56px，右侧按浮动账号簇的实际宽度让位（`--studio-header-actions-width`
 * 由 Header 测量写入）。`leading` 放在标题前（返回按钮、面包屑）。
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
        'flex h-14 shrink-0 items-center gap-3 border-b border-border pl-4 pr-[max(1rem,calc(var(--studio-header-actions-width,0px)+1.75rem))] md:pl-6 md:pr-[max(1.5rem,calc(var(--studio-header-actions-width,0px)+2rem))]',
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
