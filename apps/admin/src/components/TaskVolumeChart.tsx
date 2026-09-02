import { memo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { volumeTick } from '@/lib/format'
import type { TaskVolumeBucket, VolumeBucketUnit } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface TaskVolumeChartProps {
  buckets: TaskVolumeBucket[]
  bucketUnit: VolumeBucketUnit
  label: string
  className?: string
}

// darkMode: 'media'，shadcn chart 的 theme:{light,dark} 走 .dark 选择器，这里用 CSS 变量代替。
const CHART_CONFIG = {
  completed: { label: '成功', color: 'hsl(var(--success))' },
  failed: { label: '失败', color: 'hsl(var(--danger))' },
} satisfies ChartConfig

function TaskVolumeChartImpl({ buckets, bucketUnit, label, className }: TaskVolumeChartProps) {
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.total))

  return (
    <ChartContainer
      config={CHART_CONFIG}
      role="img"
      aria-label={`${label}，峰值每个时间段 ${peak} 个任务`}
      className={cn('aspect-auto h-52 w-full', className)}
    >
      <BarChart data={buckets} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="bucket_at"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: number) => volumeTick(value, bucketUnit)}
        />
        <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} tickMargin={4} />
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
  )
}

export const TaskVolumeChart = memo(TaskVolumeChartImpl)
