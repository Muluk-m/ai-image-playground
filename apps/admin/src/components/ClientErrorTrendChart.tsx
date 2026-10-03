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
import type { ClientErrorTrendBucket, VolumeBucketUnit } from '@/lib/types'

const CHART_CONFIG = {
  boot: { label: '启动失败', color: 'hsl(var(--danger))' },
  runtime: { label: '运行期错误', color: 'hsl(var(--warning))' },
} satisfies ChartConfig

function ClientErrorTrendChartImpl({
  buckets,
  bucketUnit,
}: {
  buckets: ClientErrorTrendBucket[]
  bucketUnit: VolumeBucketUnit
}) {
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.boot + bucket.runtime))
  return (
    <ChartContainer
      config={CHART_CONFIG}
      role="img"
      aria-label={`前端错误趋势，峰值每个时间段 ${peak} 次`}
      className="aspect-auto h-52 w-full"
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
        <Bar dataKey="boot" stackId="errors" fill="var(--color-boot)" radius={0} />
        <Bar dataKey="runtime" stackId="errors" fill="var(--color-runtime)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  )
}

export const ClientErrorTrendChart = memo(ClientErrorTrendChartImpl)
