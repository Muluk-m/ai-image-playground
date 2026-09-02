import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { TaskVolumeBucket } from '@/lib/types'

interface TaskVolumeChartProps {
  buckets: TaskVolumeBucket[]
  label: string
  className?: string
}

const CHART_CONFIG = {
  completed: { label: '成功', color: 'hsl(var(--chart-ok))' },
  failed: { label: '失败', color: 'hsl(var(--chart-fail))' },
} satisfies ChartConfig

const HOUR_MS = 3600_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function TaskVolumeChart({ buckets, label, className }: TaskVolumeChartProps) {
  // 桶间距决定轴标签粒度，避免在调用点重复服务端的 range → bucket 规则
  const hourly = buckets.length > 1 && buckets[1]!.bucket_at - buckets[0]!.bucket_at <= HOUR_MS

  const formatTick = (value: number): string => {
    const date = new Date(value)
    return hourly
      ? `${pad(date.getHours())}:00`
      : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.total))

  return (
    <div role="img" aria-label={`${label}，峰值每个时间段 ${peak} 个任务`}>
      <ChartContainer config={CHART_CONFIG} className={className ?? 'aspect-auto h-52 w-full'}>
        <BarChart data={buckets} margin={{ left: 4, right: 4, top: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket_at"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={formatTick}
          />
          <YAxis
            width={32}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickMargin={4}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) =>
                  new Date(Number(payload[0]?.payload?.bucket_at ?? 0)).toLocaleString()
                }
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="completed" stackId="volume" fill="var(--color-completed)" radius={0} />
          <Bar dataKey="failed" stackId="volume" fill="var(--color-failed)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}
