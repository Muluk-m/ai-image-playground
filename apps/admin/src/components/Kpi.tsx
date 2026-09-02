import type { ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface KpiProps {
  label: string
  value: ReactNode
  note?: ReactNode
  /** card 自带卡片外框；inline 用于已经在卡片里的事实行。 */
  variant?: 'card' | 'inline'
  tone?: 'default' | 'success' | 'danger'
}

const TONE_CLASS: Record<NonNullable<KpiProps['tone']>, string> = {
  default: '',
  success: 'text-success',
  danger: 'text-danger',
}

export function Kpi({ label, value, note, variant = 'card', tone = 'default' }: KpiProps) {
  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-2 font-mono font-semibold tabular-nums tracking-tight',
          variant === 'card' ? 'mt-3 text-2xl' : 'text-lg',
          TONE_CLASS[tone],
        )}
      >
        {value}
      </p>
      {note ? <div className="mt-1 truncate text-xs text-muted-foreground">{note}</div> : null}
    </>
  )
  if (variant === 'inline') return <div>{body}</div>
  return (
    <Card>
      <CardContent className="p-4">{body}</CardContent>
    </Card>
  )
}
