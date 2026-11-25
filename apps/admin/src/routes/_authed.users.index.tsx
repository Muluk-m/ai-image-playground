import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { FilterBar, type FilterChip, presetWindow } from '@/components/FilterBar'
import { ListPagination } from '@/components/ListPagination'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { UserFormDialog } from '@/components/UserFormDialog'
import { UserTable } from '@/components/UserTable'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePrivateAdminOverlayEnabled } from '@/lib/private-overlay'
import { refreshUserKpis, useUserKpis, useUsers } from '@/lib/queries'
import { parseUsersSearch } from '@/lib/search-params'
import { parseUserSegment, type UserSegment } from '../../contracts'

export const Route = createFileRoute('/_authed/users/')({
  validateSearch: parseUsersSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: UsersPage,
})

const SEGMENTS: ReadonlyArray<{
  value: UserSegment | 'all'
  label: string
  billing?: boolean
  warning?: boolean
}> = [
  { value: 'all', label: '全部用户' },
  { value: 'active-7d', label: '7 日活跃' },
  { value: 'members', label: '付费会员', billing: true },
  { value: 'expiring', label: '7 天内到期', billing: true, warning: true },
  { value: 'out-of-credits', label: '积分耗尽', billing: true, warning: true },
  { value: 'disabled', label: '已停用' },
]

function UsersPage() {
  const search = Route.useSearch()
  const term = search.q ?? ''
  const queryClient = useQueryClient()
  const [clock] = useState(() => Date.now())
  const preset = search.preset ?? 'all'
  const activeWindow =
    preset === 'custom' && search.activeFrom !== undefined && search.activeTo !== undefined
      ? { from: search.activeFrom, to: search.activeTo }
      : preset === 'today' || preset === '7d' || preset === '30d'
        ? presetWindow(preset, clock)
        : undefined
  const kpis = useUserKpis()
  const billingEnabled = usePrivateAdminOverlayEnabled()
  const query = useUsers(term, {
    status: search.status,
    segment: search.segment,
    segments: true,
    registeredFrom: search.registeredFrom,
    registeredTo: search.registeredTo,
    activeFrom: activeWindow?.from ?? search.activeFrom,
    activeTo: activeWindow?.to ?? search.activeTo,
    sort: search.sort,
    dir: search.dir,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 50,
  })
  const [creating, setCreating] = useState(false)

  return (
    <Page
      crumbs={[{ label: '用户' }]}
      actions={
        <>
          {kpis.data ? (
            <span className="mr-2 whitespace-nowrap text-xs text-muted-foreground">
              24h 提交{' '}
              <span className="font-mono text-foreground">{kpis.data.submissions_24h}</span>
              {' · '}失败率{' '}
              <span className="font-mono text-foreground">
                {Math.round(kpis.data.failure_rate_24h * 1000) / 10}%
              </span>
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            aria-busy={query.isFetching}
            onClick={() =>
              void Promise.all([
                queryClient.invalidateQueries({ queryKey: ['users'] }),
                refreshUserKpis(queryClient),
                queryClient.invalidateQueries({ queryKey: ['private-billing', 'user-summaries'] }),
              ])
            }
          >
            <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
            {query.isFetching ? '刷新中…' : '刷新'}
          </Button>
          <Button size="sm" variant="brand" onClick={() => setCreating(true)}>
            <Plus />
            创建用户
          </Button>
        </>
      }
    >
      <UsersContent query={query} billingEnabled={billingEnabled} />
      <UserFormDialog mode="create" open={creating} onOpenChange={setCreating} />
    </Page>
  )
}

function formatBeijingDateTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function UsersContent({
  query,
  billingEnabled,
}: {
  query: ReturnType<typeof useUsers>
  billingEnabled: boolean
}) {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const counts = query.data?.segments
  const data = query.isPlaceholderData ? undefined : query.data
  const chips: FilterChip[] = []
  if (search.status)
    chips.push({
      key: 'status',
      label: '状态',
      value: search.status === 'active' ? '正常' : '已停用',
    })
  if (search.registeredFrom || search.registeredTo)
    chips.push({
      key: 'registered',
      label: '注册时间',
      value: `${search.registeredFrom ? formatBeijingDateTime(search.registeredFrom) : '不限'} – ${search.registeredTo ? formatBeijingDateTime(search.registeredTo) : '不限'}`,
    })
  function update(patch: Partial<ReturnType<typeof Route.useSearch>>) {
    void navigate({
      search: (previous) => ({
        ...(previous ?? {}),
        ...patch,
        page: typeof patch.page === 'number' ? patch.page : 1,
      }),
      replace: true,
    })
  }
  return (
    <>
      <div className="overflow-x-auto border-b">
        <ToggleGroup
          type="single"
          value={search.segment ?? 'all'}
          aria-label="用户分群"
          onValueChange={(value) => {
            if (value) update({ segment: parseUserSegment(value) })
          }}
          className="min-w-max justify-start gap-2"
        >
          {SEGMENTS.filter(
            (segment) =>
              !segment.billing ||
              segment.value === search.segment ||
              (billingEnabled && counts?.[segment.value] !== undefined),
          ).map(({ value, label, warning }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="h-10 w-auto gap-2 whitespace-nowrap rounded-none border-b-2 border-transparent px-3 text-xs text-muted-foreground data-[state=on]:border-brand-hover data-[state=on]:bg-transparent data-[state=on]:text-foreground"
            >
              {label}
              <span
                className={`font-mono tabular-nums ${warning && counts?.[value] ? 'text-warning' : 'text-muted-foreground'}`}
              >
                {counts?.[value] ?? '—'}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <FilterBar
        savedViewKey="users"
        presets={['all', 'today', '7d', '30d', 'custom']}
        preset={search.preset ?? 'all'}
        from={search.activeFrom}
        to={search.activeTo}
        onPreset={(preset, window) =>
          update({
            preset,
            activeFrom: window?.from,
            activeTo: window?.to,
          })
        }
        search={search.q ?? ''}
        searchPlaceholder="搜索用户名、用户 ID 或备注"
        onSearch={(q) => update({ q: q || undefined })}
        chips={chips}
        definitions={[
          {
            key: 'status',
            label: '状态',
            kind: 'single',
            options: [
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '已停用' },
            ],
          },
          {
            key: 'registeredFrom',
            label: '注册起点',
            kind: 'datetime',
            placeholder: '选择注册起点',
          },
          {
            key: 'registeredTo',
            label: '注册终点',
            kind: 'datetime',
            endOfMinute: true,
            placeholder: '选择注册终点',
          },
        ]}
        values={{
          status: search.status ?? '',
          registeredFrom: search.registeredFrom ? String(search.registeredFrom) : '',
          registeredTo: search.registeredTo ? String(search.registeredTo) : '',
        }}
        onChange={(key, value) => update({ [key]: key === 'status' ? value : Number(value) })}
        onRemove={(key) =>
          update(
            key === 'registered'
              ? { registeredFrom: undefined, registeredTo: undefined }
              : { [key]: undefined },
          )
        }
        onClear={() => void navigate({ search: {}, replace: true })}
      />
      {query.isError ? (
        <ErrorState
          label="加载用户失败"
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : !data ? (
        <PendingState label="加载用户" />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <UserTable
            users={data.users}
            sort={search.sort ?? 'activity'}
            dir={search.dir ?? 'desc'}
            onSort={(sort) =>
              update({
                sort,
                dir: search.sort === sort && search.dir !== 'asc' ? 'asc' : 'desc',
              })
            }
          />
          <ListPagination
            page={data.page}
            pageSize={data.pageSize === 100 ? 100 : 50}
            total={data.total}
            onPage={(next) => update({ page: next })}
            onPageSize={(size) => update({ pageSize: size, page: 1 })}
          />
        </div>
      )}
    </>
  )
}
