import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import {
  type PrivateAdminUserSummary,
  privateUserSummaryColumnTitle,
  usePrivateAdminUserSummaries,
} from '@/lib/private-overlay'
import type { AdminUserRow } from '@/lib/types'
import { FuzzyTime } from './FuzzyTime'

const USER_DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const LOGIN_METHOD_LABELS: Readonly<Record<string, string>> = {
  password: '密码',
  google: 'Google',
}

function UserIdentity({ user }: { user: AdminUserRow }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm font-semibold">{user.username}</span>
      <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
        {user.id}
      </span>
    </span>
  )
}

function LoginMethods({
  methods,
  align = 'start',
}: {
  methods: readonly string[]
  align?: 'start' | 'end'
}) {
  return (
    <div className={`flex flex-wrap gap-1 ${align === 'end' ? 'justify-end' : ''}`}>
      {methods.map((method) => (
        <Badge key={method} variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
          {LOGIN_METHOD_LABELS[method] ?? method}
        </Badge>
      ))}
    </div>
  )
}

function SummaryValue({ summary }: { summary: PrivateAdminUserSummary | undefined }) {
  return (
    <span className="block min-w-0 text-right">
      <span
        className={`block truncate font-mono text-xs font-semibold ${
          summary?.tone === 'warning' ? 'text-amber-600' : ''
        }`}
      >
        {summary?.primary ?? '…'}
      </span>
      <span
        className="mt-0.5 flex min-w-0 items-center justify-end gap-1 text-[10px] text-muted-foreground"
        style={summary?.accent ? { color: summary.accent } : undefined}
      >
        {summary?.badge}
        <span className="truncate">{summary?.secondary ?? '读取中'}</span>
      </span>
    </span>
  )
}

function MobileMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 min-w-0 text-sm">{children}</div>
    </div>
  )
}

export function UserTable({ users }: { users: AdminUserRow[] }) {
  const { enabled: privateAdminOverlayEnabled, summaries } = usePrivateAdminUserSummaries(
    users.map((user) => user.id),
  )
  const gridColumns = privateAdminOverlayEnabled
    ? 'grid-cols-[minmax(190px,1.4fr)_90px_105px_115px_165px_170px_28px]'
    : 'grid-cols-[minmax(190px,1.4fr)_90px_105px_115px_165px_28px]'
  if (!users.length) return <EmptyState label="没有匹配的用户" />

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card/70 shadow-sm">
      <div
        className={`hidden ${gridColumns} border-b bg-muted/40 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground xl:grid`}
      >
        <span>用户</span>
        <span>状态</span>
        <span className="text-right">任务 / 会话</span>
        <span className="text-right">最近活动</span>
        <span className="text-right">注册 / 登录方式</span>
        {privateAdminOverlayEnabled ? (
          <span className="text-right">{privateUserSummaryColumnTitle}</span>
        ) : null}
        <span />
      </div>

      <div className="hidden divide-y xl:block">
        {users.map((user) => (
          <Link
            key={user.id}
            to="/users/$userId"
            params={{ userId: user.id }}
            className={`group grid ${gridColumns} items-center px-4 py-3 transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
          >
            <UserIdentity user={user} />
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
            <span className="min-w-0 text-right">
              <span className="mb-1 block text-xs tabular-nums">
                {USER_DATE_FORMAT.format(user.created_at)}
              </span>
              <LoginMethods methods={user.login_methods} align="end" />
            </span>
            {privateAdminOverlayEnabled ? <SummaryValue summary={summaries[user.id]} /> : null}
            <span className="flex justify-end">
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </span>
          </Link>
        ))}
      </div>

      <div className="divide-y xl:hidden">
        {users.map((user) => (
          <Link
            key={user.id}
            to="/users/$userId"
            params={{ userId: user.id }}
            className="group block min-w-0 px-4 py-4 transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-3">
              <UserIdentity user={user} />
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                  {user.status === 'active' ? '正常' : '已停用'}
                </Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </span>
            </span>

            <span className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">
              <MobileMetric label="任务 / 会话">
                <span className="font-mono text-xs tabular-nums">
                  {user.task_count}
                  <span className="mx-1.5 text-border">/</span>
                  {user.active_sessions}
                </span>
              </MobileMetric>
              <MobileMetric label="最近活动">
                <span className="text-xs">
                  <FuzzyTime ts={user.last_activity_at} />
                </span>
              </MobileMetric>
              <MobileMetric label="注册日期">
                <span className="text-xs tabular-nums">
                  {USER_DATE_FORMAT.format(user.created_at)}
                </span>
              </MobileMetric>
              <MobileMetric label="登录方式">
                <LoginMethods methods={user.login_methods} />
              </MobileMetric>
              {privateAdminOverlayEnabled ? (
                <span className="col-span-2 flex min-w-0 items-start justify-between gap-4 border-t pt-3">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {privateUserSummaryColumnTitle}
                  </span>
                  <SummaryValue summary={summaries[user.id]} />
                </span>
              ) : null}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
