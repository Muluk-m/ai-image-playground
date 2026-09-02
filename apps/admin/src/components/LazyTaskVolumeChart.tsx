import { lazy, Suspense } from 'react'

import { PendingState } from '@/components/Page'
import type { TaskVolumeChartProps } from '@/components/TaskVolumeChart'

// recharts 约 400 kB：懒加载把它挡在入口包外，登录页不用为图表付费。
const TaskVolumeChart = lazy(async () => ({
  default: (await import('@/components/TaskVolumeChart')).TaskVolumeChart,
}))

export function LazyTaskVolumeChart(props: TaskVolumeChartProps) {
  return (
    <Suspense fallback={<PendingState label="加载图表" className={props.className} />}>
      <TaskVolumeChart {...props} />
    </Suspense>
  )
}
