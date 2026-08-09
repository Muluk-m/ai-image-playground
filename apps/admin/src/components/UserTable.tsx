import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { AdminUserRow } from '@/lib/types'

import { FuzzyTime } from './FuzzyTime'

export function UserTable({ users }: { users: AdminUserRow[] }) {
  if (!users.length) {
    return (
      <div className="rounded-lg border border-dashed bg-card/40 p-12 text-center text-sm text-muted-foreground">
        没有匹配的用户
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card/70 shadow-sm">
      <div className="grid grid-cols-[minmax(220px,1.4fr)_110px_120px_140px_36px] border-b bg-muted/40 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <span>用户</span>
        <span>状态</span>
        <span className="text-right">任务 / 会话</span>
        <span className="text-right">最近活动</span>
        <span />
      </div>
      <div className="divide-y">
        {users.map((user) => (
          <Link
            key={user.id}
            to="/users/$userId"
            params={{ userId: user.id }}
            className="group grid grid-cols-[minmax(220px,1.4fr)_110px_120px_140px_36px] items-center px-4 py-3 transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{user.username}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                {user.id}
              </span>
            </span>
            <span>
              <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                {user.status === 'active' ? '正常' : '已停用'}
              </Badge>
            </span>
            <span className="text-right font-mono text-xs tabular-nums">
              {user.task_count}
              <span className="mx-1.5 text-border">/</span>
              {user.active_sessions}
            </span>
            <span className="text-right text-xs">
              <FuzzyTime ts={user.last_activity_at} />
            </span>
            <span className="flex justify-end">
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
