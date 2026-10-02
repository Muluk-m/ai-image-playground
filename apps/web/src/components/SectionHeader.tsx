import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

/** 区块标题 + 右侧「查看全部」类链接；链接文字与下方网格右边缘对齐。 */
export default function SectionHeader({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: ReactNode
  icon?: ReactNode
  action?: { label: ReactNode; onClick: () => void; expanded?: boolean }
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <h2 className="inline-flex shrink-0 items-center gap-1.5 text-title font-semibold">
        {icon}
        {title}
      </h2>
      {children}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          aria-expanded={action.expanded}
          className="group ml-auto inline-flex items-center gap-1 rounded-sm text-body-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
          {!action.expanded ? (
            <ArrowRight
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          ) : null}
        </button>
      ) : null}
    </div>
  )
}
