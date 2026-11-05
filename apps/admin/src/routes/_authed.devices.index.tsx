import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { DeviceTable } from '@/components/DeviceTable'
import { FilterBar, presetWindow } from '@/components/FilterBar'
import { ListPagination } from '@/components/ListPagination'
import { ErrorState, Page, PendingState } from '@/components/Page'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDevices } from '@/lib/queries'
import {
  DEFAULT_RANGE,
  DEFAULT_SORT,
  parseDevicesSearch,
  SORT_LABEL,
  SORTS,
  type SortKey,
} from '@/lib/search-params'

export const Route = createFileRoute('/_authed/devices/')({
  validateSearch: parseDevicesSearch,
  component: DevicesIndex,
})

function DevicesIndex() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [clock] = useState(() => Date.now())
  const preset =
    search.preset ?? (search.range === '1d' ? 'today' : search.range === '30d' ? '30d' : '7d')
  const range =
    search.range ?? (preset === '30d' ? '30d' : preset === 'today' ? '1d' : DEFAULT_RANGE)
  const window =
    preset === 'custom' && search.from !== undefined
      ? { from: search.from, to: search.to }
      : preset === 'today'
        ? presetWindow('today', clock)
        : undefined
  const sort = search.sort ?? DEFAULT_SORT
  const q = useDevices(range, sort, {
    q: search.q,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 50,
    from: window?.from,
    to: window?.to,
  })

  function setSort(next: SortKey): void {
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, sort: next }),
      replace: true,
    })
  }

  return (
    <Page crumbs={[{ label: '设备' }]} description="按设备聚合生成任务与活跃状态">
      <FilterBar
        savedViewKey="devices"
        preset={preset}
        from={window?.from ?? search.from}
        to={window?.to ?? search.to}
        onPreset={(next, span) => {
          void navigate({
            to: '.',
            search: (previous) => ({
              ...previous,
              preset: next,
              range: next === '30d' ? '30d' : next === '7d' ? '7d' : '1d',
              from: next === 'custom' ? span?.from : next === 'today' ? span?.from : undefined,
              to: next === 'custom' ? span?.to : next === 'today' ? span?.to : undefined,
              page: 1,
            }),
            replace: true,
          })
        }}
        search={search.q ?? ''}
        searchPlaceholder="搜索设备 ID"
        onSearch={(value) =>
          void navigate({
            to: '.',
            search: (previous) => ({ ...(previous ?? {}), q: value || undefined, page: 1 }),
            replace: true,
          })
        }
        chips={[]}
        definitions={[
          {
            key: 'sort',
            label: '排序',
            kind: 'single',
            options: SORTS.map((key) => ({ value: key, label: SORT_LABEL[key] })),
          },
        ]}
        values={{ sort }}
        onChange={(_key, value) => setSort(value as SortKey)}
        onRemove={() => setSort(DEFAULT_SORT)}
        onClear={() =>
          void navigate({
            to: '.',
            search: { range: DEFAULT_RANGE, sort: DEFAULT_SORT },
            replace: true,
          })
        }
      />
      <div className="flex justify-end">
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
      </div>

      {q.isPending ? (
        <PendingState label="加载设备" />
      ) : q.isError ? (
        <ErrorState label="加载失败" error={q.error} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <DeviceTable devices={q.data.devices} range={range} />
          <ListPagination
            page={q.data.page}
            pageSize={q.data.pageSize === 100 ? 100 : 50}
            total={q.data.total}
            onPage={(page) =>
              void navigate({
                to: '.',
                search: (previous) => ({ ...previous, page }),
                replace: true,
              })
            }
            onPageSize={(pageSize) =>
              void navigate({
                to: '.',
                search: (previous) => ({ ...previous, pageSize, page: 1 }),
                replace: true,
              })
            }
          />
        </div>
      )}
    </Page>
  )
}
