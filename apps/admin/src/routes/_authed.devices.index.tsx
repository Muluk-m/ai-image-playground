import { createFileRoute } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import { DeviceTable } from '@/components/DeviceTable'
import { useDevices } from '@/lib/queries'
import { parseDevicesSearch } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/devices/')({
  validateSearch: parseDevicesSearch,
  component: DevicesIndex,
})

function DevicesIndex() {
  const search = Route.useSearch()
  const range = search.range ?? '7d'
  const sort = search.sort ?? 'last_seen'
  const q = useDevices(range, sort)

  if (q.isPending) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中
      </div>
    )
  }
  if (q.isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
        加载失败：{(q.error as Error).message}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">设备</h2>
        <span className="text-xs text-muted-foreground">
          共 {q.data.devices.length} 个
          {q.data.truncated ? '（仅显示前 500 条）' : ''}
        </span>
      </div>
      {q.data.truncated ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          结果已截断到前 500 条，可能有更多设备未显示
        </div>
      ) : null}
      <DeviceTable devices={q.data.devices} range={range} />
    </div>
  )
}
