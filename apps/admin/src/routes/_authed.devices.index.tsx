import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { DeviceTable } from '@/components/DeviceTable'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { RangeToggle } from '@/components/RangeToggle'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDevices } from '@/lib/queries'
import {
  DEFAULT_SORT,
  parseDevicesSearch,
  SORT_LABEL,
  SORTS,
  type SortKey,
} from '@/lib/search-params'
import { useRangeSearch } from '@/lib/useRangeSearch'

export const Route = createFileRoute('/_authed/devices/')({
  validateSearch: parseDevicesSearch,
  component: DevicesIndex,
})

function DevicesIndex() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [range, setRange] = useRangeSearch()
  const sort = search.sort ?? DEFAULT_SORT
  const q = useDevices(range, sort)

  function setSort(next: SortKey): void {
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, sort: next }),
      replace: true,
    })
  }

  return (
    <Page crumbs={[{ label: '设备' }]} description="按设备聚合的任务活动">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {q.isSuccess
            ? `共 ${q.data.devices.length} 个${q.data.truncated ? ' · 已截断到前 500 条' : ''}`
            : null}
        </p>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(next) => setSort(next as SortKey)}>
            <SelectTrigger className="h-8 w-[132px] text-xs" aria-label="排序">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((key) => (
                <SelectItem key={key} value={key} className="text-xs">
                  {SORT_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <RangeToggle value={range} onChange={setRange} />
        </div>
      </div>

      {q.isPending ? (
        <PendingState label="加载设备" />
      ) : q.isError ? (
        <ErrorState label="加载失败" error={q.error} />
      ) : (
        <DeviceTable devices={q.data.devices} range={range} />
      )}
    </Page>
  )
}
