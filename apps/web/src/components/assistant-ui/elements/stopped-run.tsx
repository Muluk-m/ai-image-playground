// Adapted from assistant-ui Elements (MIT): elements-stopped-run.json.
import { SquareIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import { field } from './surfaces'

export function StoppedRun({
  reason,
  children,
  actions,
  className,
  ...props
}: ComponentProps<'div'> & { reason: string; actions?: ReactNode }) {
  return (
    <div
      data-slot="stopped-run"
      role="status"
      className={cn(
        'flex w-full flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3',
        className,
      )}
      {...props}
    >
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            field,
            'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs text-muted-foreground',
          )}
        >
          <SquareIcon aria-hidden className="size-2.5 fill-current" />
          {reason}
        </span>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
