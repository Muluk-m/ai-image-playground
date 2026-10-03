import { useId } from 'react'

import { cn } from '@/lib/utils'

/** KPI 旁的小走势：只看形状，不标刻度。颜色取 currentColor，由外层的语义色决定。 */
export function Sparkline({
  values,
  className,
}: {
  values: readonly number[]
  className?: string
}) {
  const gradient = useId()
  if (values.length < 2) return null
  const width = 120
  const height = 36
  const max = Math.max(...values)
  const min = Math.min(...values)
  const x = (index: number) => 4 + (index / (values.length - 1)) * (width - 8)
  const y = (value: number) => height - 3 - ((value - min) / (max - min || 1)) * (height - 8)
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ')
  const last = values.length - 1
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-9 w-24 shrink-0', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`4,${height} ${points} ${width - 4},${height}`} fill={`url(#${gradient})`} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <circle cx={x(last)} cy={y(values[last]!)} r={2.6} fill="currentColor" />
    </svg>
  )
}
