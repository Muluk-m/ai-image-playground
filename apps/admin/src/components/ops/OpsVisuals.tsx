import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

const colors = {
  blue: 'text-sky-600 dark:text-sky-400',
  violet: 'text-violet-600 dark:text-violet-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  amber: 'text-amber-600 dark:text-amber-400',
  green: 'text-success',
  red: 'text-danger',
} as const
export function ResourceGauge({
  label,
  ratio,
  value,
  note,
  tone = 'blue',
  alert = false,
}: {
  label: string
  ratio: number | null
  value: ReactNode
  note?: ReactNode
  tone?: keyof typeof colors
  alert?: boolean
}) {
  const used = ratio === null ? null : Math.max(0, Math.min(1, ratio))
  return (
    <Card className="flex items-center gap-4 bg-muted/20 p-4 shadow-none">
      <div className={`relative size-20 shrink-0 ${alert ? colors.red : colors[tone]}`}>
        <svg
          viewBox="0 0 100 100"
          className="size-full -rotate-90"
          role="img"
          aria-label={`${label} ${used === null ? '无读数' : Math.round(used * 100) + '%'}`}
        >
          <title>{label}</title>
          <circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke="currentColor"
            strokeWidth="7"
            opacity="0.12"
          />
          {used !== null ? (
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${used * 264} 264`}
            />
          ) : null}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums">
          {used === null ? '—' : `${Math.round(used * 100)}%`}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p>
      </div>
    </Card>
  )
}

export function OutcomeBar({
  label,
  completed,
  failed,
  tone = 'green',
}: {
  label: string
  completed: number
  failed: number
  tone?: 'green' | 'violet'
}) {
  const total = completed + failed
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">
        <span className={colors[tone]}>{completed}</span>
        <span className="px-2 text-muted-foreground">/</span>
        <span className={failed ? 'text-danger' : 'text-muted-foreground'}>{failed}</span>
      </p>
      <Progress
        className={`h-2 ${total ? 'bg-danger' : 'bg-muted'} ${tone === 'violet' ? '[&>div]:bg-violet-500' : '[&>div]:bg-success'}`}
        aria-label={`${label}：完成 ${completed}，失败 ${failed}`}
        value={total ? (completed / total) * 100 : 0}
      />
      <p className="text-[11px] text-muted-foreground">
        {total ? `完成率 ${((completed / total) * 100).toFixed(1)}%` : '暂无任务样本'}
      </p>
    </div>
  )
}
