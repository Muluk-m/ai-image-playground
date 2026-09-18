import { lazy, Suspense } from 'react'

import type { ApiTrendChartProps } from '@/components/ops/ApiTrendChart'
import { PendingState } from '@/components/Page'

const ApiTrendChart = lazy(async () => ({
  default: (await import('@/components/ops/ApiTrendChart')).ApiTrendChart,
}))

export function LazyApiTrendChart(props: ApiTrendChartProps) {
  return (
    <Suspense fallback={<PendingState label="加载图表" />}>
      <ApiTrendChart {...props} />
    </Suspense>
  )
}
