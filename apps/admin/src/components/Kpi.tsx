import type { ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber'
import { cn } from '@/lib/utils'

interface KpiProps {
  label: string
  value: ReactNode
  note?: ReactNode
  /** card 自带卡片外框；inline 用于已经在卡片里的事实行。 */
  variant?: 'card' | 'inline'
  tone?: 'default' | 'success' | 'warning' | 'danger'
}

const TONE_CLASS: Record<NonNullable<KpiProps['tone']>, string> = {
  default: '',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

interface ParsedMetric {
  num: number
  decimals: number
  grouped: boolean
  suffix: string
}

const SIMPLE_METRIC_RE = /^(-?\d[\d,]*(?:\.\d+)?)(%?)$/

function parseMetric(value: ReactNode): ParsedMetric | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value)
    const dot = text.indexOf('.')
    return {
      num: value,
      decimals: dot >= 0 ? text.length - dot - 1 : 0,
      grouped: false,
      suffix: '',
    }
  }
  if (typeof value === 'string') {
    const match = SIMPLE_METRIC_RE.exec(value.trim())
    if (!match) return null
    const rawNum = match[1]
    const num = Number(rawNum.replace(/,/g, ''))
    if (!Number.isFinite(num)) return null
    const dot = rawNum.indexOf('.')
    return {
      num,
      decimals: dot >= 0 ? rawNum.length - dot - 1 : 0,
      grouped: rawNum.includes(','),
      suffix: match[2] ?? '',
    }
  }
  return null
}

function formatMetric(num: number, meta: ParsedMetric): string {
  const formatted = meta.grouped
    ? num.toLocaleString('en-US', {
        minimumFractionDigits: meta.decimals,
        maximumFractionDigits: meta.decimals,
      })
    : meta.decimals > 0
      ? num.toFixed(meta.decimals)
      : String(Math.round(num))
  return `${formatted}${meta.suffix}`
}

export function Kpi({ label, value, note, variant = 'card', tone = 'default' }: KpiProps) {
  const metric = parseMetric(value)
  const animated = useAnimatedNumber(metric ? metric.num : null, 280, metric?.decimals ?? 0)
  const renderedValue =
    metric && animated !== null && animated !== metric.num ? formatMetric(animated, metric) : value

  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-2 font-mono font-semibold tabular-nums tracking-tight',
          variant === 'card' ? 'mt-3 text-2xl' : 'text-lg',
          TONE_CLASS[tone],
        )}
      >
        {renderedValue}
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
