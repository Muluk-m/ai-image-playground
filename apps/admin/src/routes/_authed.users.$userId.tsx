import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
import { FuzzyTime } from '@/components/FuzzyTime'
import { LightboxDialog } from '@/components/LightboxDialog'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { RecentUserTasks } from '@/components/RecentUserTasks'
import { ShortId } from '@/components/ShortId'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { UserFormDialog } from '@/components/UserFormDialog'
import { UserNoteDialog } from '@/components/UserNoteDialog'
import { LoginMethods, RegistrationOrigin } from '@/components/UserTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiClient } from '@/lib/api-client'
import { bytes } from '@/lib/format'
import { PrivateAdminUserDetailPanel, usePrivateAdminUserSummaries } from '@/lib/private-overlay'
import { useUserDetail } from '@/lib/queries'
import { clearTaskView, parseUserDetailSearch } from '@/lib/search-params'
import type { AdminUserRow, UserDetailResult } from '@/lib/types'

export const Route = createFileRoute('/_authed/users/$userId')({
  validateSearch: parseUserDetailSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: UserDetailPage,
})

function UserOperations({ user }: { user: AdminUserRow }) {
  const queryClient = useQueryClient()
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState<'status' | 'sessions' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: ({ operation, reason }: { operation: 'status' | 'sessions'; reason: string }) => {
      const id = encodeURIComponent(user.id)
      if (operation === 'sessions')
        return apiClient.post(`/api/users/${id}/revoke-sessions`, { reason })
      return apiClient.patch(`/api/users/${id}`, {
        status: user.status === 'active' ? 'disabled' : 'active',
        reason,
      })
    },
    onSuccess: async (_data, variables) => {
      setConfirming(null)
      setNotice(
        variables.operation === 'sessions'
          ? '已撤销全部活跃会话'
          : user.status === 'active'
            ? '已停用该账号'
            : '已启用该账号',
      )
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
        title={user.active_sessions === 0 ? '当前无活跃会话' : undefined}
        onClick={() => {
          setNotice(null)
          setConfirming('sessions')
        }}
      >
        <LogOut /> 撤销会话
      </Button>
      <Button
        variant={user.status === 'active' ? 'destructive' : 'outline'}
        size="sm"
        disabled={mutation.isPending}
        onClick={() => {
          setNotice(null)
          setConfirming('status')
        }}
      >
        {user.status === 'active' ? <ShieldOff /> : <ShieldCheck />}
        {user.status === 'active' ? '停用' : '启用'}
      </Button>
      {notice ? (
        <span role="status" className="text-xs font-medium text-success">
          {notice}
        </span>
      ) : null}
      {mutation.isError ? <span className="text-xs text-destructive">操作失败，请重试</span> : null}
      <UserFormDialog mode="reset" user={user} open={resetting} onOpenChange={setResetting} />
      <DangerConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
        title={
          confirming === 'sessions'
            ? `撤销 ${user.username} 的会话?`
            : user.status === 'active'
              ? `停用 ${user.username}?`
              : `启用 ${user.username}?`
        }
        impact={
          confirming === 'sessions'
            ? `将撤销 ${user.active_sessions} 个未过期会话，用户需要重新登录。`
            : user.status === 'active'
              ? '停用后不能登录，现有会话会一并撤销。'
              : '启用后该用户可以重新登录。'
        }
        confirmLabel={
          confirming === 'sessions'
            ? '确认撤销'
            : user.status === 'active'
              ? '确认停用'
              : '确认启用'
        }
        destructive={confirming === 'sessions' || user.status === 'active'}
        pending={mutation.isPending}
        onConfirm={(reason) => {
          if (!confirming) return
          mutation.mutate({ operation: confirming, reason })
        }}
      />
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
      <Page crumbs={[{ label: '用户', to: '/users' }, { label: user?.username ?? userId }]}>
        {query.isPending ? (
          <PendingState label="加载用户档案" />
        ) : query.isError ? (
          <ErrorState label="加载失败" error={query.error} />
        ) : !query.data || !user ? (
          <EmptyState label={`未找到用户 ${userId}`} />
        ) : (
          <UserDetailContent
            key={userId}
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-md bg-muted font-mono text-sm font-semibold"
            aria-hidden="true"
          >
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold">{user.username}</h2>
              <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                {user.status === 'active' ? '正常' : '已停用'}
              </Badge>
            </div>
            <ShortId value={user.id} len={12} />
          </div>
        </div>
        <UserOperations user={user} />
      </div>
      <PrivateAdminUserDetailPanel
        userId={user.id}
        username={user.username}
        profile={<UserProfile detail={detail} user={user} />}
      >
        <RecentUserTasks userId={userId} status={status} onStatusChange={updateStatus} />
      </PrivateAdminUserDetailPanel>
    </>
  )
}

function UserProfile({ detail, user }: { detail: UserDetailResult; user: AdminUserRow }) {
  const [editingNote, setEditingNote] = useState(false)
  const syncEnabled = Route.useRouteContext({
    select: (context) => context.adminSession.accounts_sync,
  })
  const { summaries } = usePrivateAdminUserSummaries([user.id])
  const summary = summaries[user.id]

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 p-4">
        <CardTitle>用户画像</CardTitle>
        <Button variant="ghost" onClick={() => setEditingNote(true)}>
          {user.note ? '编辑备注' : '添加备注'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-sm">
          {user.note || '暂无备注'}
        </p>
        <dl className="divide-y">
          <ProfileFact label="注册时间">
            {new Date(user.created_at).toLocaleDateString('zh-CN')}
          </ProfileFact>
          {summary?.registrationSource ? (
            <ProfileFact label="注册来源">
              <RegistrationOrigin summary={summary} align="end" />
            </ProfileFact>
          ) : null}
          <ProfileFact label="登录方式">
            <LoginMethods methods={user.login_methods} align="end" />
          </ProfileFact>
          <ProfileFact label="最近登录">
            {user.last_login_at ? <FuzzyTime ts={user.last_login_at} /> : '从未登录'}
          </ProfileFact>
          <ProfileFact label="活跃会话">{user.active_sessions}</ProfileFact>
          <ProfileFact label="历史生成任务">{user.task_count}</ProfileFact>
          {syncEnabled ? (
            <>
              <ProfileFact label="云端模板">{detail.template_count}</ProfileFact>
              <ProfileFact label="云端素材">
                {detail.asset_count} · {bytes(detail.asset_bytes)}
              </ProfileFact>
            </>
          ) : null}
        </dl>
      </CardContent>
      <UserNoteDialog user={user} open={editingNote} onOpenChange={setEditingNote} />
    </Card>
  )
}

function ProfileFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  )
}
