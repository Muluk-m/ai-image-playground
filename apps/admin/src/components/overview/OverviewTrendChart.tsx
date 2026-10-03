import { memo } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { volumeTick } from '@/lib/format'
import type { OverviewResult, VolumeBucketUnit } from '@/lib/types'

export type TrendMetric = 'tasks' | 'agent'

export interface OverviewTrendChartProps {
  metric: TrendMetric
  overview: OverviewResult
  bucketUnit: VolumeBucketUnit
}

const TASK_CONFIG = {
  completed: { label: '成功', color: 'hsl(var(--success))' },
  failed: { label: '失败', color: 'hsl(var(--danger))' },
  rate: { label: '失败率', color: 'hsl(var(--warning))' },
} satisfies ChartConfig

const AGENT_CONFIG = {
  agent_completed: { label: '完成', color: 'hsl(var(--success))' },
  agent_failed: { label: '失败', color: 'hsl(var(--danger))' },
  agent_aborted: { label: '用户中断', color: 'hsl(var(--muted-foreground))' },
} satisfies ChartConfig

function OverviewTrendChartImpl({ metric, overview, bucketUnit }: OverviewTrendChartProps) {
  const tick = (value: number) => volumeTick(value, bucketUnit)
  const label = (_label: unknown, payload: Array<{ payload?: { bucket_at?: number } }>) =>
    new Date(Number(payload[0]?.payload?.bucket_at ?? 0)).toLocaleString()

  if (metric === 'agent') {
    return (
      <ChartContainer
        config={AGENT_CONFIG}
        role="img"
        aria-label="Agent 轮次趋势"
        className="aspect-auto h-60 w-full"
      >
        <ComposedChart data={overview.pulse.series} margin={{ left: 4, right: 4, top: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket_at"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={tick}
          />
          <YAxis
            width={36}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickMargin={4}
          />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={label} />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="agent_completed" stackId="agent" fill="var(--color-agent_completed)" />
          <Bar
            dataKey="agent_aborted"
            stackId="agent"
            fill="var(--color-agent_aborted)"
            fillOpacity={0.45}
          />
          <Bar
            dataKey="agent_failed"
            stackId="agent"
            fill="var(--color-agent_failed)"
            radius={[2, 2, 0, 0]}
          />
        </ComposedChart>
      </ChartContainer>
    )
  }

  // 失败率按已结束的任务算；还在跑的不进分母。
  const rows = overview.volume.map((bucket) => {
    const terminal = bucket.completed + bucket.failed
    return { ...bucket, rate: terminal > 0 ? bucket.failed / terminal : null }
  })
  return (
    <ChartContainer
      config={TASK_CONFIG}
      role="img"
      aria-label="生成任务趋势与失败率"
      className="aspect-auto h-60 w-full"
    >
      <ComposedChart data={rows} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="bucket_at"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={tick}
        />
        <YAxis
          yAxisId="count"
          width={36}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          tickMargin={4}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          width={40}
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          domain={[0, 'auto']}
          tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={label}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ background: item.color }} />
                    {TASK_CONFIG[name as keyof typeof TASK_CONFIG]?.label ?? name}
                  </span>
                  <span className="font-mono tabular-nums">
                    {name === 'rate'
                      ? value === null
                        ? '—'
                        : `${(Number(value) * 100).toFixed(1)}%`
                      : Number(value).toLocaleString('zh-CN')}
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar yAxisId="count" dataKey="completed" stackId="tasks" fill="var(--color-completed)" />
        <Bar
          yAxisId="count"
          dataKey="failed"
          stackId="tasks"
          fill="var(--color-failed)"
          radius={[2, 2, 0, 0]}
        />
        <Line
          yAxisId="rate"
          dataKey="rate"
          type="monotone"
          stroke="var(--color-rate)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ChartContainer>
  )
}

export const OverviewTrendChart = memo(OverviewTrendChartImpl)
