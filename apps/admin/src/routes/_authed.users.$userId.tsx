import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, KeyRound, Loader2, LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { LightboxDialog } from '@/components/LightboxDialog'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { TaskVolumeChart } from '@/components/TaskVolumeChart'
import { UserFormDialog } from '@/components/UserFormDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminUserDetailPanel } from '@/lib/private-overlay'
import { useUserDetail } from '@/lib/queries'
import { parseUserDetailSearch } from '@/lib/search-params'
import type { AdminUserRow } from '@/lib/types'

export const Route = createFileRoute('/_authed/users/$userId')({
  validateSearch: parseUserDetailSearch,
  component: UserDetailPage,
})

const TASK_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'completed', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'in_progress', label: '执行中' },
  { value: 'queued', label: '排队中' },
] as const

function Stat({ label, value, note }: { label: string; value: string; note: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background/55 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums">{value}</p>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>
    </div>
  )
}

function UserOperations({ user }: { user: AdminUserRow }) {
  const queryClient = useQueryClient()
  const [resetting, setResetting] = useState(false)
  const mutation = useMutation({
    mutationFn: (operation: 'status' | 'sessions') => {
      const id = encodeURIComponent(user.id)
      if (operation === 'sessions') return apiClient.post(`/api/users/${id}/revoke-sessions`)
      return apiClient.patch(`/api/users/${id}`, {
        status: user.status === 'active' ? 'disabled' : 'active',
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['users'] }),
      ])
    },
  })

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setResetting(true)}>
        <KeyRound /> 重置密码
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={mutation.isPending || user.active_sessions === 0}
        onClick={() => {
          if (window.confirm(`撤销 ${user.username} 的全部登录会话？`)) mutation.mutate('sessions')
        }}
      >
        <LogOut /> 撤销会话
      </Button>
      <Button
        variant={user.status === 'active' ? 'destructive' : 'default'}
        size="sm"
        disabled={mutation.isPending}
        onClick={() => {
          const verb = user.status === 'active' ? '停用' : '启用'
          if (window.confirm(`${verb}用户 ${user.username}？`)) mutation.mutate('status')
        }}
      >
        {user.status === 'active' ? <ShieldOff /> : <ShieldCheck />}
        {user.status === 'active' ? '停用账号' : '启用账号'}
      </Button>
      {mutation.isError ? (
        <span className="self-center text-xs text-destructive">操作失败，请重试</span>
      ) : null}
      <UserFormDialog mode="reset" user={user} open={resetting} onOpenChange={setResetting} />
    </div>
  )
}

function UserDetailPage() {
  const { userId } = Route.useParams()
  const search = Route.useSearch()
  const range = search.range ?? '7d'
  const status = search.status ?? 'all'
  const navigate = useNavigate()
  const query = useUserDetail(userId, range, status)
  const pages = query.data?.pages ?? []
  const detail = pages[0] ?? null
  const tasks = pages.flatMap((page) => page.tasks)

  function updateStatus(nextStatus: string): void {
    void navigate({
      to: '.',
      search: (previous) => ({
        ...previous,
        status: nextStatus === 'all' ? undefined : nextStatus,
      }),
      replace: true,
    })
  }

  function closeTask(): void {
    void navigate({
      to: '.',
      search: (previous) => {
        const {
          task: _task,
          fullscreen: _fullscreen,
          imgIdx: _index,
          imgKind: _kind,
          ...rest
        } = previous ?? {}
        return rest
      },
    })
  }

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/users' })}>
        <ChevronLeft /> 返回用户中心
      </Button>

      {query.isPending ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载用户档案
        </div>
      ) : query.isError ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
          加载失败：{(query.error as Error).message}
        </div>
      ) : !detail || !detail.user ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          未找到用户 {userId}
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-xl border bg-card/60 shadow-sm">
            <div className="flex items-start justify-between gap-5 border-b bg-muted/25 p-5">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h1 className="truncate text-2xl font-semibold tracking-tight">
                    {detail.user.username}
                  </h1>
                  <Badge variant={detail.user.status === 'active' ? 'success' : 'secondary'}>
                    {detail.user.status === 'active' ? '正常' : '已停用'}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{detail.user.id}</p>
              </div>
              <UserOperations user={detail.user} />
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
              <Stat label="任务" value={String(detail.user.task_count)} note="账号全部历史" />
              <Stat
                label="活跃会话"
                value={String(detail.user.active_sessions)}
                note="当前未过期会话"
              />
              <Stat
                label="最近活动"
                value={detail.user.last_activity_at ? '已活动' : '无记录'}
                note={<FuzzyTime ts={detail.user.last_activity_at} />}
              />
              <Stat
                label="创建时间"
                value={new Date(detail.user.created_at).toLocaleDateString()}
                note={new Date(detail.user.created_at).toLocaleString()}
              />
            </div>
          </section>

          <PrivateAdminUserDetailPanel userId={detail.user.id} username={detail.user.username} />

          {detail.volume ? (
            <section className="rounded-xl border bg-card/40 p-4">
              <div className="mb-4 flex items-baseline justify-between">
                <div>
                  <h2 className="text-sm font-semibold">该用户的任务趋势</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{range} 时间窗内的提交与失败</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {detail.volume.reduce((sum, bucket) => sum + bucket.total, 0)} tasks
                </span>
              </div>
              <TaskVolumeChart buckets={detail.volume} label={`${detail.user.username} 的任务量`} />
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-3">
              <div>
                <h2 className="text-sm font-semibold">任务时间线</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  已加载 {tasks.length} 条 · 从新到旧
                </p>
              </div>
              <div className="flex rounded-md border bg-muted/25 p-0.5" aria-label="任务状态筛选">
                {TASK_FILTERS.map((filter) => (
                  <Button
                    key={filter.value}
                    size="sm"
                    variant={status === filter.value ? 'secondary' : 'ghost'}
                    className="h-7 px-2.5 text-xs"
                    onClick={() => updateStatus(filter.value)}
                  >
                    {filter.label}
                  </Button>
                ))}
              </div>
            </div>
            <TaskTable
              tasks={tasks}
              hasNextPage={query.hasNextPage}
              isFetchingNextPage={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          </section>
        </>
      )}

      <TaskDetailSheet
        taskId={search.task}
        onOpenChange={(open) => {
          if (!open) closeTask()
        }}
      />
      <LightboxDialog
        taskId={search.task}
        imgIdx={search.imgIdx}
        imgKind={search.imgKind}
        fullscreen={search.fullscreen}
      />
    </div>
  )
}
