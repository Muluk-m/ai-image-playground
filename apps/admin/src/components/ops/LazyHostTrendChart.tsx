import { lazy, Suspense } from 'react'

import type { HostTrendChartProps } from '@/components/ops/HostTrendChart'
import { PendingState } from '@/components/Page'

// 与任务脉冲图同理：recharts 很重，只在真的要画的时候才加载。
const HostTrendChart = lazy(async () => ({
  default: (await import('@/components/ops/HostTrendChart')).HostTrendChart,
}))

export function LazyHostTrendChart(props: HostTrendChartProps) {
  return (
    <Suspense fallback={<PendingState label="加载图表" />}>
      <HostTrendChart {...props} />
    </Suspense>
  )
}
