import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api-client'
import type { AdminUserRow, UserStatus } from '@/lib/types'

import { FuzzyTime } from './FuzzyTime'

interface UserTableProps {
  users: AdminUserRow[]
  onResetPassword: (user: AdminUserRow) => void
}

export function UserTable({ users, onResetPassword }: UserTableProps) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function changeStatus(user: AdminUserRow, status: UserStatus): Promise<void> {
    if (
      status === 'disabled' &&
      !window.confirm(`禁用 ${user.username}？该账号的所有登录会话会立即失效。`)
    ) {
      return
    }
    setPending(`${user.id}:status`)
    setError(null)
    try {
      await apiClient.patch(`/api/users/${encodeURIComponent(user.id)}`, { status })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    } catch {
      setError(`未能${status === 'active' ? '启用' : '禁用'} ${user.username}`)
    } finally {
      setPending(null)
    }
  }

  async function revokeSessions(user: AdminUserRow): Promise<void> {
    if (!window.confirm(`退出 ${user.username} 的全部登录设备？`)) return
    setPending(`${user.id}:sessions`)
    setError(null)
    try {
      await apiClient.post(`/api/users/${encodeURIComponent(user.id)}/revoke-sessions`)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    } catch {
      setError(`未能撤销 ${user.username} 的登录会话`)
    } finally {
      setPending(null)
    }
  }

  if (!users.length) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        还没有用户账号
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[850px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-3 font-medium">账号</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">活跃会话</th>
              <th className="px-4 py-3 font-medium">任务数</th>
              <th className="px-4 py-3 font-medium">最近登录</th>
              <th className="px-4 py-3 font-medium">创建时间</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const statusPending = pending === `${user.id}:status`
              const sessionsPending = pending === `${user.id}:sessions`
              return (
                <tr key={user.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{user.username}</div>
                    <div className="mt-0.5 max-w-44 truncate font-mono text-[10px] text-muted-foreground">
                      {user.id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                      {user.status === 'active' ? '正常' : '已禁用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{user.active_sessions}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{user.task_count}</td>
                  <td className="px-4 py-3">
                    <FuzzyTime ts={user.last_login_at} />
                  </td>
                  <td className="px-4 py-3">
                    <FuzzyTime ts={user.created_at} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        title="重置密码"
                        onClick={() => onResetPassword(user)}
                        disabled={pending !== null}
                      >
                        <KeyRound />
                        密码
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="退出全部登录设备"
                        onClick={() => void revokeSessions(user)}
                        disabled={pending !== null || user.active_sessions === 0}
                      >
                        <LogOut />
                        {sessionsPending ? '退出中' : '退出会话'}
                      </Button>
                      <Button
                        size="sm"
                        variant={user.status === 'active' ? 'ghost' : 'outline'}
                        title={user.status === 'active' ? '禁用账号' : '启用账号'}
                        onClick={() =>
                          void changeStatus(user, user.status === 'active' ? 'disabled' : 'active')
                        }
                        disabled={pending !== null}
                      >
                        {user.status === 'active' ? <ShieldOff /> : <ShieldCheck />}
                        {statusPending ? '处理中' : user.status === 'active' ? '禁用' : '启用'}
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
