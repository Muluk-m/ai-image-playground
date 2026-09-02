import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { useMemo, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { LazyTaskVolumeChart } from '@/components/LazyTaskVolumeChart'
import { LightboxDialog } from '@/components/LightboxDialog'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { UserFormDialog } from '@/components/UserFormDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminUserDetailPanel } from '@/lib/private-overlay'
import { useUserDetail, useUserTasks } from '@/lib/queries'
import { clearTaskView, parseUserDetailSearch, RANGE_LABEL } from '@/lib/search-params'
import type { AdminUserRow, UserDetailResult } from '@/lib/types'

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
  const navigate = useNavigate()
  const query = useUserDetail(userId)
  const user = query.data?.user ?? null

  function closeTask(): void {
    void navigate({ to: '.', search: clearTaskView })
  }

  return (
    <>
      <Page
        crumbs={[{ label: '用户', to: '/users' }, { label: user?.username ?? userId }]}
        description="全部历史任务与账户操作"
      >
        {query.isPending ? (
          <PendingState label="加载用户档案" />
        ) : query.isError ? (
          <ErrorState label="加载失败" error={query.error} />
        ) : !query.data || !user ? (
          <EmptyState label={`未找到用户 ${userId}`} />
        ) : (
          <UserDetailContent
            detail={query.data}
            user={user}
            status={search.status ?? 'all'}
            userId={userId}
          />
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

function UserDetailContent({
  detail,
  user,
  status,
  userId,
}: {
  detail: UserDetailResult
  user: AdminUserRow
  status: string
  userId: string
}) {
  const navigate = useNavigate()
  const tasksQuery = useUserTasks(userId, status)
  const tasks = useMemo(
    () => (tasksQuery.data?.pages ?? []).flatMap((page) => page.tasks),
    [tasksQuery.data],
  )
  const createdAt = new Date(user.created_at)

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

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold tracking-tight">{user.username}</h2>
                <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                  {user.status === 'active' ? '正常' : '已停用'}
                </Badge>
              </div>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{user.id}</p>
            </div>
            <UserOperations user={user} />
          </div>

          <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              variant="inline"
              label="创建"
              value={createdAt.toLocaleDateString()}
              note={createdAt.toLocaleTimeString()}
            />
            <Kpi
              variant="inline"
              label="最近活动"
              value={<FuzzyTime ts={user.last_activity_at} />}
            />
            <Kpi variant="inline" label="活跃会话" value={String(user.active_sessions)} />
            <Kpi variant="inline" label="历史任务" value={String(user.task_count)} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="min-w-0">
          <PrivateAdminUserDetailPanel userId={user.id} username={user.username} />
        </div>

        <Card className="min-w-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
            <CardTitle className="text-sm">
              任务
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                已加载 {tasks.length} 条 · 从新到旧
              </span>
            </CardTitle>
            <SegmentedControl
              options={TASK_FILTERS}
              value={status}
              onChange={updateStatus}
              label="任务状态筛选"
            />
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0">
            <p className="text-[11px] text-muted-foreground">
              任务趋势 · 近 {RANGE_LABEL[detail.volume_range]}
            </p>
            <LazyTaskVolumeChart
              buckets={detail.volume}
              bucketUnit={detail.volume_bucket}
              label={`${user.username} 的任务量`}
              className="h-32"
            />
            {tasksQuery.isPending ? (
              <PendingState label="加载任务" />
            ) : tasksQuery.isError ? (
              <ErrorState label="加载任务失败" error={tasksQuery.error} />
            ) : (
              <TaskTable
                tasks={tasks}
                hasNextPage={tasksQuery.hasNextPage}
                isFetchingNextPage={tasksQuery.isFetchingNextPage}
                onLoadMore={() => void tasksQuery.fetchNextPage()}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
