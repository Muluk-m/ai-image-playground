import { memo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { OpsHostPoint } from '@/lib/types'

export interface HostTrendChartProps {
  series: OpsHostPoint[]
  /** 服务端降采样桶宽；相邻点超过 1.5 桶时曲线必须断开。 */
  stepMs: number
  /** 磁盘告警线，0 到 1。画出来，运营者才看得出这条曲线离它还有多远。 */
  diskAlertRatio: number
  label: string
}

const CHART_CONFIG = {
  disk: { label: '磁盘已用', color: 'hsl(var(--danger))' },
  memory: { label: '内存已用', color: 'hsl(var(--success))' },
  cpu: { label: 'CPU', color: 'hsl(var(--primary))' },
} satisfies ChartConfig

interface TrendRow {
  at: number
  disk: number | null
  memory: number | null
  cpu: number | null
}

/**
 * 相邻两点之间缺了格子，就在中间补一个全空的点，曲线在那里断开。
 * 不补的话，机器卡死的那九个小时会被画成一条平滑的斜线，看起来像内存在慢慢变化。
 */
export function trendRows(series: OpsHostPoint[], stepMs = 30 * 60 * 1000): TrendRow[] {
  const percent = (ratio: number | null) => (ratio === null ? null : Math.round(ratio * 1000) / 10)
  const rows: TrendRow[] = []
  for (const point of series) {
    const previous = rows[rows.length - 1]
    if (previous && point.at - previous.at > stepMs * 1.5) {
      rows.push({ at: previous.at + stepMs, disk: null, memory: null, cpu: null })
    }
    rows.push({
      at: point.at,
      disk: percent(point.disk_used_ratio),
      memory: percent(1 - point.mem_available_ratio),
      cpu: percent(point.cpu_busy_ratio),
    })
  }
  return rows
}

const HOUR_MS = 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 刻度的写法跟着曲线的跨度走。采集容器刚启用的头几天，整条曲线都在一两天之内，
 * 按「月-日」标出来的刻度全是同一个日期，等于没标。
 */
export function trendTick(at: number, spanMs: number): string {
  const date = new Date(at)
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (spanMs <= 24 * HOUR_MS) return time
  if (spanMs <= 72 * HOUR_MS) return `${day} ${time}`
  return day
}

function HostTrendChartImpl({ series, stepMs, diskAlertRatio, label }: HostTrendChartProps) {
  const data = trendRows(series, stepMs)
  const hasCpu = data.some((row) => row.cpu !== null)
  const spanMs = data.length > 1 ? data[data.length - 1].at - data[0].at : 0
  return (
    <ChartContainer
      config={CHART_CONFIG}
      role="img"
      aria-label={label}
      className="aspect-auto h-48 w-full"
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
          tickFormatter={(at: number) => trendTick(at, spanMs)}
        />
        <YAxis width={36} domain={[0, 100]} tickLine={false} axisLine={false} unit="%" />
        <ReferenceLine y={diskAlertRatio * 100} stroke="hsl(var(--danger))" strokeDasharray="4 4" />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) =>
                new Date(Number(payload[0]?.payload?.at ?? 0)).toLocaleString()
              }
              formatter={(value, name) => (
                <div className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">
                    {CHART_CONFIG[name as keyof typeof CHART_CONFIG]?.label ?? name}
                  </span>
                  <span className="font-mono tabular-nums">{value}%</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
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
        {hasCpu ? (
          <Line
            dataKey="cpu"
            stroke="var(--color-cpu)"
            dot={false}
            strokeWidth={1}
            strokeOpacity={0.7}
            isAnimationActive={false}
          />
        ) : null}
      </LineChart>
    </ChartContainer>
  )
}

export const HostTrendChart = memo(HostTrendChartImpl)
