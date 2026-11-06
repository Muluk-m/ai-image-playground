import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { FilterBar, type FilterChip, presetWindow } from '@/components/FilterBar'
import { Kpi } from '@/components/Kpi'
import { ListPagination } from '@/components/ListPagination'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { UserFormDialog } from '@/components/UserFormDialog'
import { UserTable } from '@/components/UserTable'
import { Button } from '@/components/ui/button'
import { useUsers } from '@/lib/queries'
import { parseUsersSearch } from '@/lib/search-params'
import type { ListUsersResult } from '@/lib/types'

export const Route = createFileRoute('/_authed/users/')({
  validateSearch: parseUsersSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: UsersPage,
})

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
  const query = useUsers(term, {
    status: search.status,
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
      description="开通、会话与任务追踪"
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            aria-busy={query.isFetching}
            onClick={() =>
              void Promise.all([
                queryClient.invalidateQueries({ queryKey: ['users'] }),
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
      {query.isPending ? (
        <PendingState label="加载用户" />
      ) : query.isError ? (
        <ErrorState label="加载用户失败" error={query.error} />
      ) : (
        <UsersContent data={query.data} />
      )}
      <UserFormDialog mode="create" open={creating} onOpenChange={setCreating} />
    </Page>
  )
}

function UsersContent({ data }: { data: ListUsersResult }) {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { users, kpis, total, page, pageSize } = data
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
      value: `${search.registeredFrom ?? '…'} – ${search.registeredTo ?? '…'}`,
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
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="用户指标">
        <Kpi label="用户总数" value={String(kpis.total_users)} note="所有用户" />
        <Kpi label="7 日活跃" value={String(kpis.active_users_7d)} note="登录或提交过任务" />
        <Kpi label="24h 提交" value={String(kpis.submissions_24h)} note="全部用户任务" />
        <Kpi
          label="24h 失败率"
          value={`${Math.round(kpis.failure_rate_24h * 1000) / 10}%`}
          note="失败 / 提交"
        />
      </section>
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
          { key: 'registeredFrom', label: '注册起点（毫秒）', kind: 'number' },
          { key: 'registeredTo', label: '注册终点（毫秒）', kind: 'number' },
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
      <div className="overflow-hidden rounded-xl border bg-card">
        <UserTable
          users={users}
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
          page={page ?? 1}
          pageSize={pageSize === 100 ? 100 : 50}
          total={total ?? users.length}
          onPage={(next) => update({ page: next })}
          onPageSize={(size) => update({ pageSize: size, page: 1 })}
        />
      </div>
    </>
  )
}
