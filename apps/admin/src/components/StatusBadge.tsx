import { Badge } from '@/components/ui/badge'
import type { TaskStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

interface StatusBadgeProps {
  status: TaskStatus
  className?: string
}

const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; badgeClass: string; dotClass: string; pulse?: boolean }
> = {
  completed: {
    label: '成功',
    badgeClass: 'border-success/25 bg-success/15 text-success',
    dotClass: 'bg-success',
  },
  failed: {
    label: '失败',
    badgeClass: 'border-danger/25 bg-danger/15 text-danger',
    dotClass: 'bg-danger',
  },
  reconciling: {
    label: '待核查',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    dotClass: 'bg-warning',
  },
  in_progress: {
    label: '运行中',
    badgeClass: 'border-info/25 bg-info/15 text-info',
    dotClass: 'bg-info',
    pulse: true,
  },
  queued: {
    label: '排队中',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    dotClass: 'bg-warning',
  },
  cancelled: {
    label: '已取消',
    badgeClass: 'border-border bg-muted text-muted-foreground',
    dotClass: 'bg-muted-foreground',
  },
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status]
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 px-2 font-medium', config.badgeClass, className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          config.dotClass,
          config.pulse && 'animate-pulse',
        )}
      />
      {config.label}
    </Badge>
  )
}
