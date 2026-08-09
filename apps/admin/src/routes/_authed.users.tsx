import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2, Plus, Search, UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import { UserFormDialog } from '@/components/UserFormDialog'
import { UserTable } from '@/components/UserTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUsers } from '@/lib/queries'
import { parseUsersSearch } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/users')({
  validateSearch: parseUsersSearch,
  component: UsersPage,
})

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border bg-card/60 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>
    </div>
  )
}

function UsersPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const term = search.q ?? ''
  const query = useUsers(term)
  const [draft, setDraft] = useState(term)
  const [creating, setCreating] = useState(false)

  useEffect(() => setDraft(term), [term])

  if (query.isPending) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载用户
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
        加载用户失败：{(query.error as Error).message}
      </div>
    )
  }

  const kpis = query.data.kpis
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between border-b pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Account operations
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">用户中心</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            从账号开始处理开通、投诉、会话与任务追踪
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          创建用户
        </Button>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="用户指标">
        <Kpi label="用户总数" value={String(kpis.total_users)} note="所有账号" />
        <Kpi label="7 日活跃" value={String(kpis.active_users_7d)} note="登录或提交过任务" />
        <Kpi label="24h 提交" value={String(kpis.submissions_24h)} note="全部用户任务" />
        <Kpi
          label="24h 失败率"
          value={`${Math.round(kpis.failure_rate_24h * 1000) / 10}%`}
          note="失败 / 提交"
        />
      </section>

      <form
        className="flex max-w-xl gap-2"
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
            className="pl-9"
            placeholder="按用户名或用户 ID 搜索"
            aria-label="搜索用户"
          />
        </div>
        <Button type="submit" variant="outline">
          查询
        </Button>
      </form>

      {term ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Search className="h-3.5 w-3.5" />“{term}” 匹配 {query.data.users.length} 个用户
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <UsersRound className="h-3.5 w-3.5" />
          按最近活动排序 · 任务数与会话数并列展示
        </div>
      )}

      {query.data.truncated ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          结果已截断到最新的 1000 个用户
        </div>
      ) : null}
      <UserTable users={query.data.users} />
      <UserFormDialog mode="create" open={creating} onOpenChange={setCreating} />
    </div>
  )
}
