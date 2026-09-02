import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { LightboxDialog } from '@/components/LightboxDialog'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { TaskVolumeChart } from '@/components/TaskVolumeChart'
import { UserFormDialog } from '@/components/UserFormDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminUserDetailPanel } from '@/lib/private-overlay'
import { useUserDetail } from '@/lib/queries'
import { parseUserDetailSearch } from '@/lib/search-params'
import type { AdminUserRow } from '@/lib/types'

export const Route = createFileRoute('/_authed/users/$userId')({
  validateSearch: parseUserDetailSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: UserDetailPage,
})

const TASK_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'completed', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'in_progress', label: '执行中' },
  { value: 'queued', label: '排队中' },
] as const

function Fact({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</p>
      {note ? <div className="text-[11px] text-muted-foreground">{note}</div> : null}
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
    <div className="flex flex-wrap items-center gap-2">
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
        variant={user.status === 'active' ? 'destructive' : 'outline'}
        size="sm"
        disabled={mutation.isPending}
        onClick={() => {
          const verb = user.status === 'active' ? '停用' : '启用'
          if (window.confirm(`${verb}用户 ${user.username}？`)) mutation.mutate('status')
        }}
      >
        {user.status === 'active' ? <ShieldOff /> : <ShieldCheck />}
        {user.status === 'active' ? '停用' : '启用'}
      </Button>
      {mutation.isError ? <span className="text-xs text-destructive">操作失败，请重试</span> : null}
      <UserFormDialog mode="reset" user={user} open={resetting} onOpenChange={setResetting} />
    </div>
  )
}

function UserDetailPage() {
  const { userId } = Route.useParams()
  const search = Route.useSearch()
  const status = search.status ?? 'all'
  const navigate = useNavigate()
  const query = useUserDetail(userId, status)
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
    <>
      <Page
        crumbs={[{ label: '用户', to: '/users' }, { label: detail?.user?.username ?? userId }]}
        title={detail?.user?.username ?? '用户详情'}
        description="全部历史任务与账户操作"
      >
        {query.isPending ? (
          <PendingState label="加载用户档案" />
        ) : query.isError ? (
          <ErrorState label="加载失败" error={query.error} />
        ) : !detail || !detail.user ? (
          <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
            未找到用户 {userId}
          </div>
        ) : (
          <>
            <Card>
              <CardContent className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-lg font-semibold tracking-tight">
                        {detail.user.username}
                      </h2>
                      <Badge variant={detail.user.status === 'active' ? 'success' : 'secondary'}>
                        {detail.user.status === 'active' ? '正常' : '已停用'}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {detail.user.id}
                    </p>
                  </div>
                  <UserOperations user={detail.user} />
                </div>

                <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Fact
                    label="创建"
                    value={new Date(detail.user.created_at).toLocaleDateString()}
                    note={new Date(detail.user.created_at).toLocaleTimeString()}
                  />
                  <Fact
                    label="最近活动"
                    value={detail.user.last_activity_at ? '已活动' : '无记录'}
                    note={<FuzzyTime ts={detail.user.last_activity_at} />}
                  />
                  <Fact label="活跃会话" value={String(detail.user.active_sessions)} />
                  <Fact label="历史任务" value={String(detail.user.task_count)} />
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
              <div className="min-w-0">
                <PrivateAdminUserDetailPanel
                  userId={detail.user.id}
                  username={detail.user.username}
                />
              </div>

              <Card className="min-w-0">
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
                  <CardTitle className="text-sm">
                    任务
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      已加载 {tasks.length} 条 · 从新到旧
                    </span>
                  </CardTitle>
                  <div
                    className="flex rounded-md border bg-muted/25 p-0.5"
                    aria-label="任务状态筛选"
                  >
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
                </CardHeader>
                <CardContent className="space-y-3 p-4 pt-0">
                  {detail.volume ? (
                    <>
                      <p className="text-[11px] text-muted-foreground">任务趋势 · 近 30 天</p>
                      <TaskVolumeChart
                        buckets={detail.volume}
                        label={`${detail.user.username} 的任务量`}
                        className="aspect-auto h-32 w-full"
                      />
                    </>
                  ) : null}
                  <TaskTable
                    tasks={tasks}
                    hasNextPage={query.hasNextPage}
                    isFetchingNextPage={query.isFetchingNextPage}
                    onLoadMore={() => void query.fetchNextPage()}
                  />
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </Page>

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
    </>
  )
}
