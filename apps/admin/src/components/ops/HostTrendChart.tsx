import { memo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { OpsHostPoint } from '@/lib/types'

export interface HostTrendChartProps {
  series: OpsHostPoint[]
  /** 磁盘告警线，0 到 1。画出来，运营者才看得出这条曲线离它还有多远。 */
  diskAlertRatio: number
  label: string
}

const CHART_CONFIG = {
  disk: { label: '磁盘已用', color: 'hsl(var(--danger))' },
  memory: { label: '内存已用', color: 'hsl(var(--success))' },
} satisfies ChartConfig

function dayTick(at: number): string {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function HostTrendChartImpl({ series, diskAlertRatio, label }: HostTrendChartProps) {
  const data = series.map((point) => ({
    at: point.at,
    disk: Math.round(point.disk_used_ratio * 1000) / 10,
    memory: Math.round((1 - point.mem_available_ratio) * 1000) / 10,
  }))
  return (
    <ChartContainer
      config={CHART_CONFIG}
      role="img"
      aria-label={label}
      className="aspect-auto h-40 w-full"
    >
      <LineChart data={data} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={40}
          tickFormatter={dayTick}
        />
        <YAxis width={36} domain={[0, 100]} tickLine={false} axisLine={false} unit="%" />
        <ReferenceLine y={diskAlertRatio * 100} stroke="hsl(var(--danger))" strokeDasharray="4 4" />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) =>
                new Date(Number(payload[0]?.payload?.at ?? 0)).toLocaleString()
              }
            />
          }
        />
        <Line
          dataKey="disk"
          stroke="var(--color-disk)"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
        />
        <Line
          dataKey="memory"
          stroke="var(--color-memory)"
          dot={false}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

export const HostTrendChart = memo(HostTrendChartImpl)
