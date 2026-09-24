import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { EmptyState } from '@/components/Page'
import { UserNoteDialog } from '@/components/UserNoteDialog'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
      <span className="block truncate text-sm font-semibold group-hover:text-primary">
        {user.username}
      </span>
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
function RegistrationOrigin({
  summary,
  align = 'start',
}: {
  summary: PrivateAdminUserSummary | undefined
  align?: 'start' | 'end'
}) {
  if (!summary?.registrationSource)
    return <span className="text-[10px] text-muted-foreground">读取中</span>
  if (summary.registrationSource === 'invited') {
    return (
      <span
        className={`block min-w-0 truncate text-[10px] text-muted-foreground ${
          align === 'end' ? 'text-right' : ''
        }`}
        title={summary.inviter ? `邀请人 ID：${summary.inviter.userId}` : undefined}
      >
        邀请注册
        <span className="mx-1 text-border">·</span>
        <span className="font-medium text-foreground">
          {summary.inviter?.username ?? '邀请人不可用'}
        </span>
      </span>
    )
  }
  return (
    <span
      className={`block text-[10px] text-muted-foreground ${align === 'end' ? 'text-right' : ''}`}
      title="没有邀请关系记录；邀请功能上线前的历史用户未回填"
    >
      自主注册
    </span>
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

export function UserTable({ users }: { users: AdminUserRow[] }) {
  const [editingNote, setEditingNote] = useState<AdminUserRow | null>(null)
  const { enabled: privateAdminOverlayEnabled, summaries } = usePrivateAdminUserSummaries(
    users.map((user) => user.id),
  )
  const tableWidth = privateAdminOverlayEnabled ? 'min-w-[930px]' : 'min-w-[760px]'
  if (!users.length) return <EmptyState label="没有匹配的用户" />

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card/70 shadow-sm">
      <Table className={`${tableWidth} table-fixed`}>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead className={`${privateAdminOverlayEnabled ? 'w-[26%]' : 'w-[30%]'} pl-4`}>
              用户
            </TableHead>
            <TableHead className="w-[10%]">状态</TableHead>
            <TableHead className="w-[14%] text-right">任务 / 会话</TableHead>
            <TableHead className="w-[13%] text-right">最近活动</TableHead>
            <TableHead
              className={`${privateAdminOverlayEnabled ? 'w-[19%]' : 'w-[25%]'} text-right`}
            >
              注册 / 登录方式
            </TableHead>
            {privateAdminOverlayEnabled ? (
              <TableHead className="w-[18%] pr-4 text-right">
                {privateUserSummaryColumnTitle}
              </TableHead>
            ) : (
              <TableHead className="w-[8%] pr-4 text-right">详情</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id} className="group">
              <TableCell className="pl-4">
                <Link
                  to="/users/$userId"
                  params={{ userId: user.id }}
                  className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <UserIdentity user={user} />
                </Link>
                <button
                  type="button"
                  className="mt-1 block max-w-full truncate text-left text-xs text-muted-foreground hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={user.note ?? undefined}
                  aria-label={`${user.username}：${user.note ? '编辑备注' : '添加备注'}`}
                  onClick={() => setEditingNote(user)}
                >
                  {user.note ? `备注：${user.note}` : '添加备注'}
                </button>
              </TableCell>
              <TableCell>
                <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                  {user.status === 'active' ? '正常' : '已停用'}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {user.task_count}
                <span className="mx-1.5 text-border">/</span>
                {user.active_sessions}
              </TableCell>
              <TableCell className="text-right text-xs">
                <FuzzyTime ts={user.last_activity_at} />
              </TableCell>
              <TableCell className="text-right">
                <span className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                  <span className="text-xs tabular-nums">
                    {USER_DATE_FORMAT.format(user.created_at)}
                  </span>
                  {privateAdminOverlayEnabled ? (
                    <RegistrationOrigin summary={summaries[user.id]} align="end" />
                  ) : null}
                </span>
                <LoginMethods methods={user.login_methods} align="end" />
              </TableCell>
              <TableCell className="pr-4">
                {privateAdminOverlayEnabled ? (
                  <SummaryValue summary={summaries[user.id]} />
                ) : (
                  <Link
                    to="/users/$userId"
                    params={{ userId: user.id }}
                    className="flex justify-end text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    查看
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <UserNoteDialog
        user={editingNote}
        open={editingNote !== null}
        onOpenChange={(open) => {
          if (!open) setEditingNote(null)
        }}
      />
    </div>
  )
}
