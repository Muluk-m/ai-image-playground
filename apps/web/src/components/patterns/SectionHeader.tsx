import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Icon } from '../ui/icon'

/** 区块标题。去另一页的动作用「查看全部」；原地展开用 disclosure，不离开当前页。 */
export default function SectionHeader({
  title,
  icon,
  link,
  action,
  children,
  className,
}: {
  title: ReactNode
  icon?: ReactNode
  link?: { label: ReactNode; onClick: () => void }
  action?: { label: ReactNode; onClick: () => void; expanded?: boolean; disclosure?: boolean }
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
      {link ? (
        <button
          type="button"
          onClick={link.onClick}
          className="ml-auto inline-flex items-center gap-1 text-body-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
        >
          {link.label}
          <Icon name="arrowRight" size="xs" />
        </button>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          aria-expanded={action.expanded}
          className={cn(
            'group inline-flex items-center gap-1 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11',
            link ? '' : 'ml-auto',
            action.disclosure
              ? 'h-7 rounded-md border border-border px-2.5 text-foreground hover:bg-secondary max-md:h-11'
              : 'rounded-sm px-1 text-muted-foreground hover:text-foreground max-md:px-2',
          )}
        >
          {action.label}
          {action.disclosure ? (
            <Icon
              name="chevronDown"
              size="xs"
              className={cn(
                'transition-transform motion-reduce:transition-none',
                action.expanded && 'rotate-180',
              )}
            />
          ) : !action.expanded ? (
            <Icon
              name="arrowRight"
              size="xs"
              className="transition-transform group-hover:translate-x-0.5"
            />
          ) : null}
        </button>
      ) : null}
    </div>
  )
}
