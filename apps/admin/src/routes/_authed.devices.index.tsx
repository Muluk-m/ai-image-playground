import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import { DeviceTable } from '@/components/DeviceTable'
import { PageHeader } from '@/components/PageHeader'
import { RangeToggle } from '@/components/RangeToggle'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDevices } from '@/lib/queries'
import { parseDevicesSearch, type Range, type SortKey } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/devices/')({
  validateSearch: parseDevicesSearch,
  component: DevicesIndex,
})

const SORT_LABEL: Record<SortKey, string> = {
  last_seen: '最近活跃',
  today_count: '今日任务',
  total_count: '范围总数',
}

function DevicesIndex() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const range = search.range ?? '7d'
  const sort = search.sort ?? 'last_seen'
  const q = useDevices(range, sort)

  function update(next: { range?: Range; sort?: SortKey }): void {
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
    })
  }

  return (
    <>
      <PageHeader crumbs={[{ label: '设备' }]} title="设备" description="按设备聚合的任务活动" />

      <div className="flex-1 space-y-4 px-4 py-5 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {q.isSuccess
              ? `共 ${q.data.devices.length} 个${q.data.truncated ? ' · 已截断到前 500 条' : ''}`
              : ' '}
          </p>
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={(next) => update({ sort: next as SortKey })}>
              <SelectTrigger className="h-8 w-[132px] text-xs" aria-label="排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {SORT_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <RangeToggle value={range} onChange={(next) => update({ range: next })} />
          </div>
        </div>

        {q.isPending ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中
          </div>
        ) : q.isError ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
            加载失败：{(q.error as Error).message}
          </div>
        ) : (
          <DeviceTable devices={q.data.devices} range={range} />
        )}
      </div>
    </>
  )
}
