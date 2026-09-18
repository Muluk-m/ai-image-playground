import { memo } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { trendTick } from '@/components/ops/HostTrendChart'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { OpsApiPoint } from '@/lib/types'

export interface ApiTrendChartProps {
  series: OpsApiPoint[]
  label: string
}

const CHART_CONFIG = {
  requests: { label: '请求', color: 'hsl(var(--primary))' },
  server_errors: { label: '5xx', color: 'hsl(var(--danger))' },
} satisfies ChartConfig

/** 后台按 15 分钟一格汇总；缺格说明那段时间后端没有写统计（多半没在跑），曲线在那里断开。 */
const STEP_MS = 15 * 60 * 1000

interface ApiRow {
  at: number
  requests: number | null
  server_errors: number | null
}

export function apiRows(series: OpsApiPoint[]): ApiRow[] {
  const rows: ApiRow[] = []
  for (const point of series) {
    const previous = rows[rows.length - 1]
    if (previous && point.at - previous.at > STEP_MS * 1.5) {
      rows.push({ at: previous.at + STEP_MS, requests: null, server_errors: null })
    }
    rows.push({ at: point.at, requests: point.requests, server_errors: point.server_errors })
  }
  return rows
}

function ApiTrendChartImpl({ series, label }: ApiTrendChartProps) {
  const data = apiRows(series)
  const spanMs = data.length > 1 ? data[data.length - 1].at - data[0].at : 0
  return (
    <ChartContainer
      config={CHART_CONFIG}
      role="img"
      aria-label={label}
      className="aspect-auto h-44 w-full"
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
        {/* 5xx 通常比请求数小两三个数量级，放在右边单独一根轴上才看得见。 */}
        <YAxis
          yAxisId="requests"
          width={40}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <YAxis
          yAxisId="errors"
          orientation="right"
          width={28}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) =>
                `${new Date(Number(payload[0]?.payload?.at ?? 0)).toLocaleString()} 起 15 分钟`
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          yAxisId="requests"
          dataKey="requests"
          stroke="var(--color-requests)"
          dot={false}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Line
          yAxisId="errors"
          dataKey="server_errors"
          stroke="var(--color-server_errors)"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

export const ApiTrendChart = memo(ApiTrendChartImpl)
