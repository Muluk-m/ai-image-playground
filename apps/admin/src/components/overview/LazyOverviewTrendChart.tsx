import { lazy, Suspense } from 'react'

import type { OverviewTrendChartProps } from '@/components/overview/OverviewTrendChart'
import { PendingState } from '@/components/Page'

// recharts 约 400 kB：懒加载把它挡在入口包外，登录页不用为图表付费。
const OverviewTrendChart = lazy(async () => ({
  default: (await import('@/components/overview/OverviewTrendChart')).OverviewTrendChart,
}))

export function LazyOverviewTrendChart(props: OverviewTrendChartProps) {
  return (
    <Suspense fallback={<PendingState label="加载图表" className="h-60" />}>
      <OverviewTrendChart {...props} />
    </Suspense>
  )
}

const ClientErrorTrendChart = lazy(async () => ({
  default: (await import('@/components/ClientErrorTrendChart')).ClientErrorTrendChart,
}))

export function LazyClientErrorTrendChart(
  props: React.ComponentProps<
    typeof import('@/components/ClientErrorTrendChart').ClientErrorTrendChart
  >,
) {
  return (
    <Suspense fallback={<PendingState label="加载图表" className="h-52" />}>
      <ClientErrorTrendChart {...props} />
    </Suspense>
  )
}
