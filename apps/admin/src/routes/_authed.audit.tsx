import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAudits } from '@/lib/queries'
import type { OperatorAuditRow } from '@/lib/types'

export const Route = createFileRoute('/_authed/audit')({ component: AuditPage })

/**
 * 筛选下拉里列的是后端当前会写的动作（apps/bff/src/lib/user-admin.ts、lib/inspirations.ts）。
 * 新动作忘了登记也不会丢行：列表照常显示它，只是暂时没法从下拉里单独筛出来。
 */
const ACTION_LABEL: Record<string, string> = {
  'user.create': '创建用户',
  'user.oauth-register': '三方注册',
  'user.status.update': '改用户状态',
  'user.password.reset': '重置密码',
  'user.password.self-update': '用户自改密码',
  'user.sessions.revoke': '注销全部会话',
  'user.identity.link': '绑定三方账号',
  'user.identity.unlink': '解绑三方账号',
  'inspiration.create': '新建灵感条目',
  'inspiration.update': '编辑灵感条目',
  'inspiration.delete': '删除灵感条目',
  'inspiration.draft': '灵感条目转草稿',
  'inspiration.published': '发布灵感条目',
  'inspiration.archived': '下架灵感条目',
  'inspiration.category.create': '新建灵感分类',
  'inspiration.category.update': '编辑灵感分类',
  'inspiration.category.delete': '删除灵感分类',
}

const ALL_ACTIONS = 'all'

function AuditPage() {
  const [action, setAction] = useState(ALL_ACTIONS)
  const query = useAudits({ action: action === ALL_ACTIONS ? undefined : action })
  const audits = query.data?.pages.flatMap((page) => page.audits) ?? []

  return (
    <Page
      crumbs={[{ label: '审计' }]}
      description="运营者执行过的写操作，只读"
      actions={
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="h-8 w-[180px] text-xs" aria-label="按动作筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS} className="text-xs">
              全部动作
            </SelectItem>
            {Object.entries(ACTION_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {query.isPending ? (
        <PendingState label="加载审计记录" />
      ) : query.isError ? (
        <ErrorState label="加载审计记录失败" error={query.error} />
      ) : audits.length === 0 ? (
        <EmptyState label="没有匹配的审计记录" />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border bg-card/70 shadow-sm">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[120px] pl-4">时间</TableHead>
                  <TableHead className="w-[140px]">操作者</TableHead>
                  <TableHead className="w-[200px]">动作</TableHead>
                  <TableHead className="w-[220px]">对象</TableHead>
                  <TableHead className="pr-4">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audits.map((audit) => (
                  <TableRow key={audit.id}>
                    <TableCell className="pl-4">
                      <FuzzyTime ts={audit.created_at} />
                    </TableCell>
                    <TableCell>
                      <ShortId value={audit.operator_id} len={12} />
                    </TableCell>
                    <TableCell>
                      {/* 没登记中文名的动作直接拿原始 action 当主标题，别留一行「—」让人以为漏数据。 */}
                      <span className="block text-sm">
                        {ACTION_LABEL[audit.action] ?? audit.action}
                      </span>
                      {ACTION_LABEL[audit.action] ? (
                        <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                          {audit.action}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="block text-xs text-muted-foreground">
                        {audit.target_type}
                      </span>
                      <ShortId value={audit.target_id} len={16} />
                    </TableCell>
                    <TableCell className="pr-4">
                      <span className="block max-w-[420px] truncate font-mono text-[11px] text-muted-foreground">
                        {detailText(audit.details)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  void query.fetchNextPage()
                }}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">已经到底了</p>
          )}
        </>
      )}
    </Page>
  )
}

/** details 是各动作自己写的小对象（多半一两个键），铺平成一行看比折叠的 JSON 快。 */
function detailText(details: OperatorAuditRow['details']): string {
  const parts = Object.entries(details).map(
    ([key, value]) =>
      `${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`,
  )
  return parts.length ? parts.join(' · ') : '—'
}
