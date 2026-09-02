import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Kpi } from '@/components/Kpi'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { UserFormDialog } from '@/components/UserFormDialog'
import { UserTable } from '@/components/UserTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUsers } from '@/lib/queries'
import { parseUsersSearch } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/users/')({
  validateSearch: parseUsersSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: UsersPage,
})

function UsersPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const term = search.q ?? ''
  const query = useUsers(term)
  const [draft, setDraft] = useState(term)
  const [creating, setCreating] = useState(false)

  useEffect(() => setDraft(term), [term])

  return (
    <Page
      crumbs={[{ label: '用户' }]}
      title="用户"
      description="开通、会话与任务追踪"
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus />
          创建用户
        </Button>
      }
    >
      {query.isPending ? (
        <PendingState label="加载用户" />
      ) : query.isError ? (
        <ErrorState label="加载用户失败" error={query.error} />
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="用户指标">
            <Kpi label="用户总数" value={String(query.data.kpis.total_users)} note="所有用户" />
            <Kpi
              label="7 日活跃"
              value={String(query.data.kpis.active_users_7d)}
              note="登录或提交过任务"
            />
            <Kpi
              label="24h 提交"
              value={String(query.data.kpis.submissions_24h)}
              note="全部用户任务"
            />
            <Kpi
              label="24h 失败率"
              value={`${Math.round(query.data.kpis.failure_rate_24h * 1000) / 10}%`}
              note="失败 / 提交"
            />
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <form
              className="flex w-full max-w-md gap-2"
              role="search"
              onSubmit={(event) => {
                event.preventDefault()
                void navigate({
                  to: '/users',
                  search: draft.trim() ? { q: draft.trim() } : {},
                  replace: true,
                })
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  className="h-9 pl-9"
                  placeholder="按用户名或用户 ID 搜索"
                  aria-label="搜索用户"
                />
              </div>
              <Button type="submit" variant="outline">
                查询
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              {term
                ? `“${term}” 匹配 ${query.data.users.length} 个用户`
                : `共 ${query.data.users.length} 个 · 按最近活动排序`}
              {query.data.truncated ? ' · 已截断到最新的 1000 个' : ''}
            </p>
          </div>

          <UserTable users={query.data.users} />
        </>
      )}
      <UserFormDialog mode="create" open={creating} onOpenChange={setCreating} />
    </Page>
  )
}
