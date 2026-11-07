import { Link } from '@tanstack/react-router'
import { MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { UserNoteDialog } from '@/components/UserNoteDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
    <span className="block min-w-0 truncate text-sm font-semibold group-hover:text-primary">
      {user.username}
    </span>
  )
}

function UserIdentityMeta({ user }: { user: AdminUserRow }) {
  return <ShortId value={user.id} len={10} className="mt-1 text-[10px] text-muted-foreground" />
}

function UserTimeline({
  user,
  summary,
  align = 'start',
}: {
  user: AdminUserRow
  summary?: PrivateAdminUserSummary
  align?: 'start' | 'end'
}) {
  return (
    <div className={align === 'end' ? 'text-right' : undefined}>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs tabular-nums">
        <span>注册 {USER_DATE_FORMAT.format(user.created_at)}</span>
        <span className="text-muted-foreground">
          最近登录 {user.last_login_at ? <FuzzyTime ts={user.last_login_at} /> : '从未登录'}
        </span>
      </div>
      {summary ? <RegistrationOrigin summary={summary} align={align} /> : null}
      <LoginMethods methods={user.login_methods} align={align} />
    </div>
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

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
}) {
  return (
    <button type="button" className="inline-flex items-center gap-1" onClick={onClick}>
      {label}
      <span className="text-[10px] text-muted-foreground">
        {active ? (dir === 'asc' ? '↑' : '↓') : ''}
      </span>
    </button>
  )
}

export function UserTable({
  users,
  sort = 'activity',
  dir = 'desc',
  onSort,
}: {
  users: AdminUserRow[]
  sort?: 'activity' | 'created' | 'login'
  dir?: 'asc' | 'desc'
  onSort?: (sort: 'activity' | 'created' | 'login') => void
}) {
  const [editingNote, setEditingNote] = useState<AdminUserRow | null>(null)
  const { enabled: privateAdminOverlayEnabled, summaries } = usePrivateAdminUserSummaries(
    users.map((user) => user.id),
  )
  const tableWidth = privateAdminOverlayEnabled ? 'min-w-[930px]' : 'min-w-[760px]'
  if (!users.length) return <EmptyState label="没有匹配的用户" />

  return (
    <>
      <div className="grid gap-2 md:hidden">
        {users.map((user) => (
          <article key={user.id} className="rounded-lg border bg-card/70 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to="/users/$userId" params={{ userId: user.id }} className="min-w-0">
                  <UserIdentity user={user} />
                </Link>
                <UserIdentityMeta user={user} />
              </div>
              <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                {user.status === 'active' ? '正常' : '已停用'}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground">任务 / 会话</p>
                <p className="mt-1 font-mono tabular-nums">
                  {user.task_count} / {user.active_sessions}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">最近活动</p>
                <p className="mt-1">
                  <FuzzyTime ts={user.last_activity_at} />
                </p>
              </div>
              <div className="col-span-2">
                <UserTimeline
                  user={user}
                  summary={privateAdminOverlayEnabled ? summaries[user.id] : undefined}
                />
              </div>
            </div>
            {privateAdminOverlayEnabled ? (
              <div className="mt-3 border-t pt-3">
                <p className="mb-1 text-xs text-muted-foreground">
                  {privateUserSummaryColumnTitle}
                </p>
                <SummaryValue summary={summaries[user.id]} />
              </div>
            ) : null}
            {user.note ? (
              <button
                type="button"
                className="mt-3 block max-w-full truncate text-left text-xs text-muted-foreground hover:text-primary"
                title={user.note}
                onClick={() => setEditingNote(user)}
              >
                备注：{user.note}
              </button>
            ) : (
              <span className="mt-3 block text-xs text-muted-foreground">未添加备注</span>
            )}
          </article>
        ))}
      </div>
      <div className="hidden min-w-0 overflow-hidden rounded-xl border bg-card/70 md:block">
        <Table className={`${tableWidth} table-fixed`}>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead className={`${privateAdminOverlayEnabled ? 'w-[26%]' : 'w-[30%]'} pl-4`}>
                用户
              </TableHead>
              <TableHead className="w-[10%]">状态</TableHead>
              <TableHead className="w-[14%] text-right">任务 / 会话</TableHead>
              <TableHead className="w-[13%] text-right">
                <SortHeader
                  label="最近活动"
                  active={sort === 'activity'}
                  dir={dir}
                  onClick={() => onSort?.('activity')}
                />
              </TableHead>
              <TableHead
                className={`${privateAdminOverlayEnabled ? 'w-[19%]' : 'w-[25%]'} text-right`}
              >
                <SortHeader
                  label="注册时间"
                  active={sort === 'created'}
                  dir={dir}
                  onClick={() => onSort?.('created')}
                />
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
                  <div className="min-w-0">
                    <Link
                      to="/users/$userId"
                      params={{ userId: user.id }}
                      className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <UserIdentity user={user} />
                    </Link>
                    <UserIdentityMeta user={user} />
                  </div>
                  {user.note ? (
                    <button
                      type="button"
                      className="mt-1 block max-w-full truncate text-left text-xs text-muted-foreground hover:text-primary"
                      title={user.note}
                      aria-label={`${user.username}：编辑备注`}
                      onClick={() => setEditingNote(user)}
                    >
                      备注：{user.note}
                    </button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      title="添加备注"
                      aria-label={`${user.username}：添加备注`}
                      className="mt-1 text-muted-foreground"
                      onClick={() => setEditingNote(user)}
                    >
                      <MessageSquarePlus />
                    </Button>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                    {user.status === 'active' ? '正常' : '已停用'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-baseline justify-end gap-2 whitespace-nowrap">
                    <span className="font-mono text-sm tabular-nums">{user.task_count}</span>
                    <span className="text-[11px] text-muted-foreground">任务</span>
                    <span className="font-mono text-sm tabular-nums">{user.active_sessions}</span>
                    <span className="text-[11px] text-muted-foreground">会话</span>
                  </div>
                </TableCell>
                <TableCell className="text-right text-xs">
                  <FuzzyTime ts={user.last_activity_at} />
                </TableCell>
                <TableCell className="text-right">
                  <UserTimeline
                    user={user}
                    summary={privateAdminOverlayEnabled ? summaries[user.id] : undefined}
                    align="end"
                  />
                </TableCell>
                <TableCell className="pr-4">
                  {privateAdminOverlayEnabled ? (
                    <SummaryValue summary={summaries[user.id]} />
                  ) : (
                    <Link
                      to="/users/$userId"
                      params={{ userId: user.id }}
                      className="flex justify-end text-xs text-primary hover:underline"
                    >
                      查看
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <UserNoteDialog
        user={editingNote}
        open={editingNote !== null}
        onOpenChange={(open) => {
          if (!open) setEditingNote(null)
        }}
      />
    </>
  )
}
