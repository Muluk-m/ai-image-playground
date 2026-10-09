// Presentation adapted from assistant-ui Elements job-progress (MIT), 2026-10-09.
import type { ComponentProps } from 'react'
import { cn } from '../../../lib/utils'

export function JobProgress({
  label,
  progress,
  className,
  ...props
}: ComponentProps<'div'> & { label: string; progress?: number }) {
  const value = progress === undefined ? undefined : Math.min(100, Math.max(0, progress))
  return (
    <div data-slot="job-progress" className={cn('flex w-full min-w-0 flex-col gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuetext={label}
        aria-valuemin={value === undefined ? undefined : 0}
        aria-valuemax={value === undefined ? undefined : 100}
        aria-valuenow={value}
        className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
        {...props}
      >
        <span
          className={cn(
            'block h-full rounded-full bg-foreground/75',
            value === undefined && 'agent-job-progress-sweep',
          )}
          style={{ width: value === undefined ? '34%' : `${value}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
    </div>
  )
}
