import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  ArrowUpDown,
  ArrowUpRight,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Coins,
  Cpu,
  CreditCard,
  Download,
  FileText,
  Gift,
  KeyRound,
  Link2,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldAlert,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Tag,
  Terminal,
  Trash2,
  Unlink2,
  User,
  UserCog,
  UserPlus,
  UserX,
  Wrench,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'

import { FilterBar, type FilterChip, presetWindow } from '@/components/FilterBar'
import { FuzzyTime } from '@/components/FuzzyTime'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAudits } from '@/lib/queries'
import { parseAuditSearch } from '@/lib/search-params'
import type { OperatorAuditRow } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_authed/audit')({
  validateSearch: parseAuditSearch,
  component: AuditPage,
  errorComponent: ({ error }) => (
    <Page crumbs={[{ label: '审计' }]}>
      <ErrorState label="审计筛选无效" error={error} />
    </Page>
  ),
})

type AuditTone = 'success' | 'warning' | 'danger' | 'info' | 'private' | 'neutral'

interface AuditActionMeta {
  label: string
  tone: AuditTone
  icon: LucideIcon
}

interface TargetTypeMeta {
  label: string
  tone: AuditTone
  icon: LucideIcon
}

const TONE_BADGE_CLASS: Record<AuditTone, string> = {
  success: 'border-success/25 bg-success/15 text-success',
  warning: 'border-warning/25 bg-warning/15 text-warning',
  danger: 'border-danger/25 bg-danger/15 text-danger',
  info: 'border-info/25 bg-info/15 text-info',
  private: 'border-private/25 bg-private/10 text-private',
  neutral: 'border-border bg-muted text-muted-foreground',
}

/**
 * 覆盖后端写入 operator_audits 的常见动作（用户、计费、CLI、模型网关、内容与运维）。
 * 新动作未登记也不会丢行：按前缀自动推断图标与语义色并展示原始 action。
 */
const AUDIT_ACTION_META: Record<string, AuditActionMeta> = {
  'user.create': { label: '创建用户', tone: 'success', icon: UserPlus },
  'user.register': { label: '账号注册', tone: 'success', icon: UserPlus },
  'user.oauth-register': { label: '三方注册', tone: 'info', icon: UserPlus },
  'user.status.update': { label: '变更用户状态', tone: 'warning', icon: UserCog },
  'user.note.update': { label: '修改用户备注', tone: 'neutral', icon: StickyNote },
  'user.password.reset': { label: '重置密码', tone: 'warning', icon: KeyRound },
  'user.password.self-update': { label: '用户自改密码', tone: 'neutral', icon: KeyRound },
  'user.sessions.revoke': { label: '注销全部会话', tone: 'danger', icon: LogOut },
  'user.sessions.revoke-others': { label: '注销其他会话', tone: 'warning', icon: LogOut },
  'user.identity.link': { label: '绑定三方账号', tone: 'info', icon: Link2 },
  'user.identity.unlink': { label: '解绑三方账号', tone: 'warning', icon: Unlink2 },
  'user.delete': { label: '注销用户', tone: 'danger', icon: UserX },

  'billing.settings.update': { label: '更新计费设置', tone: 'private', icon: Settings },
  'billing.plan.update': { label: '更新会员套餐', tone: 'private', icon: CreditCard },
  'billing.model_price.update': { label: '更新模型定价', tone: 'private', icon: Tag },
  'billing.payment.confirm': { label: '确认收款', tone: 'success', icon: BadgeCheck },
  'billing.credits.adjust': { label: '调整用户积分', tone: 'warning', icon: Coins },
  'billing.credits.adjust_subscription': { label: '调整订阅积分', tone: 'warning', icon: Coins },
  'billing.subscription.grant': { label: '开通套餐', tone: 'success', icon: Sparkles },
  'billing.subscription.renew': { label: '续期套餐', tone: 'success', icon: RefreshCw },
  'billing.subscription.upgrade': { label: '套餐立即升档', tone: 'info', icon: ArrowUpRight },
  'billing.subscription.schedule_change': {
    label: '预约到期换档',
    tone: 'warning',
    icon: CalendarClock,
  },
  'billing.subscription.plan_change': {
    label: '变更会员套餐',
    tone: 'private',
    icon: ArrowLeftRight,
  },
  'billing.subscription.expiry_adjust': {
    label: '调整套餐到期时间',
    tone: 'warning',
    icon: CalendarClock,
  },
  'billing.order.note': { label: '保存订单备注', tone: 'neutral', icon: FileText },
  'billing.order.reject': { label: '拒绝订单申报', tone: 'danger', icon: XCircle },
  'billing.order.reopen': { label: '重新受理订单', tone: 'warning', icon: RotateCcw },
  'billing.referral.policy.update': { label: '更新返利规则', tone: 'private', icon: Gift },
  'billing.referral.register': { label: '记录邀请注册', tone: 'info', icon: Gift },
  'billing.referral.transfer': { label: '划转邀请奖励', tone: 'success', icon: Gift },

  'cli.device_authorization.created': { label: '发起 CLI 授权', tone: 'info', icon: Terminal },
  'cli.device_authorization.approved': {
    label: '批准 CLI 授权',
    tone: 'success',
    icon: CheckCircle2,
  },
  'cli.device_authorization.denied': { label: '拒绝 CLI 授权', tone: 'danger', icon: XCircle },
  'cli.token.issued': { label: '签发 CLI 令牌', tone: 'success', icon: KeyRound },
  'cli.connection.revoked': { label: '吊销 CLI 连接', tone: 'danger', icon: ShieldOff },
  'cli.token.retired_rejected': {
    label: '拦截失效 CLI 令牌',
    tone: 'warning',
    icon: ShieldAlert,
  },

  'model.availability.update': { label: '变更模型上下架', tone: 'warning', icon: Cpu },
  'model.auto_pause': { label: '模型自动暂停', tone: 'danger', icon: PauseCircle },
  'agent.models.configure': { label: '配置 Agent 模型', tone: 'info', icon: SlidersHorizontal },
  'upstream_secret.replace': { label: '更新上游密钥', tone: 'warning', icon: KeyRound },
  'upstream_secret.clear': { label: '清除上游密钥', tone: 'danger', icon: Trash2 },
  'gpt_direct_key.create': { label: '新增直连密钥', tone: 'success', icon: KeyRound },
  'gpt_direct_key.update': { label: '更新直连密钥', tone: 'warning', icon: KeyRound },
  'gpt_direct_key.reorder': { label: '调整直连密钥顺序', tone: 'info', icon: ArrowUpDown },
  'gpt_direct_key.delete': { label: '删除直连密钥', tone: 'danger', icon: Trash2 },
  'gpt_direct_key.restore': { label: '恢复直连密钥', tone: 'success', icon: RotateCcw },
  'gemini_direct_key.create': { label: '新增 Gemini 密钥', tone: 'success', icon: KeyRound },
  'gemini_direct_key.update': { label: '更新 Gemini 密钥', tone: 'warning', icon: KeyRound },
  'gemini_direct_key.reorder': { label: '调整 Gemini 密钥顺序', tone: 'info', icon: ArrowUpDown },
  'gemini_direct_key.delete': { label: '删除 Gemini 密钥', tone: 'danger', icon: Trash2 },
  'gemini_direct_key.restore': { label: '恢复 Gemini 密钥', tone: 'success', icon: RotateCcw },

  'inspiration.create': { label: '新建灵感条目', tone: 'success', icon: Sparkles },
  'inspiration.update': { label: '编辑灵感条目', tone: 'neutral', icon: Sparkles },
  'inspiration.delete': { label: '删除灵感条目', tone: 'danger', icon: Trash2 },
  'inspiration.draft': { label: '灵感条目转草稿', tone: 'neutral', icon: FileText },
  'inspiration.published': { label: '发布灵感条目', tone: 'success', icon: CheckCircle2 },
  'inspiration.archived': { label: '下架灵感条目', tone: 'warning', icon: PauseCircle },
  'inspiration.category.create': { label: '新建灵感分类', tone: 'success', icon: Tag },
  'inspiration.category.update': { label: '编辑灵感分类', tone: 'neutral', icon: Tag },
  'inspiration.category.delete': { label: '删除灵感分类', tone: 'danger', icon: Trash2 },

  'announcement.create': { label: '新建公告', tone: 'info', icon: Megaphone },
  'announcement.update': { label: '编辑公告', tone: 'neutral', icon: Megaphone },
  'announcement.publish': { label: '发布公告', tone: 'success', icon: Megaphone },
  'announcement.unpublish': { label: '撤回公告', tone: 'warning', icon: Megaphone },
  'announcement.archive': { label: '归档公告', tone: 'neutral', icon: Megaphone },

  'feedback.reply': { label: '回复用户反馈', tone: 'info', icon: MessageSquare },
  'feedback.status': { label: '变更反馈状态', tone: 'neutral', icon: MessageSquare },

  'operator_config.set': { label: '设置运营覆盖', tone: 'info', icon: SlidersHorizontal },
  'operator_config.clear': { label: '清除运营覆盖', tone: 'warning', icon: SlidersHorizontal },
  'task.reconcile.started': { label: '发起任务核查', tone: 'info', icon: Wrench },
  'task.reconcile': { label: '完成任务核查', tone: 'success', icon: Wrench },
  'tasks.export': { label: '导出生成任务', tone: 'info', icon: Download },
}

const TARGET_TYPE_META: Record<string, TargetTypeMeta> = {
  billing_settings: { label: '计费设置', tone: 'private', icon: Settings },
  order: { label: '订单', tone: 'private', icon: CreditCard },
  plan: { label: '套餐', tone: 'private', icon: Sparkles },
  subscription: { label: '订阅', tone: 'private', icon: CalendarClock },
  cli_device_authorization: { label: 'CLI 授权', tone: 'info', icon: Terminal },
  cli_connection: { label: 'CLI 连接', tone: 'info', icon: Terminal },
  model: { label: '模型', tone: 'warning', icon: Cpu },
  agent_model_settings: { label: 'Agent 模型', tone: 'info', icon: SlidersHorizontal },
  upstream_secret: { label: '上游密钥', tone: 'warning', icon: KeyRound },
  gpt_direct_key: { label: '直连密钥', tone: 'warning', icon: KeyRound },
  gemini_direct_key: { label: 'Gemini 密钥', tone: 'info', icon: KeyRound },
  user: { label: '用户', tone: 'neutral', icon: User },
  inspiration: { label: '灵感条目', tone: 'neutral', icon: Sparkles },
  inspiration_category: { label: '灵感分类', tone: 'neutral', icon: Tag },
  announcement: { label: '公告', tone: 'info', icon: Megaphone },
  feedback_thread: { label: '用户反馈', tone: 'info', icon: MessageSquare },
  operator_config: { label: '运营配置', tone: 'info', icon: SlidersHorizontal },
  task: { label: '任务', tone: 'neutral', icon: Wrench },
  generation_tasks: { label: '生成任务', tone: 'neutral', icon: Wrench },
}

function resolveAuditAction(action: string): AuditActionMeta & { known: boolean } {
  const exact = AUDIT_ACTION_META[action]
  if (exact) return { ...exact, known: true }

  const destructive = /\.(delete|revoke|reject|denied|clear|archive)/.test(action)
  if (action.startsWith('billing.')) {
    return {
      label: action,
      tone: destructive ? 'danger' : 'private',
      icon: CreditCard,
      known: false,
    }
  }
  if (action.startsWith('cli.')) {
    return { label: action, tone: destructive ? 'danger' : 'info', icon: Terminal, known: false }
  }
  if (action.startsWith('model.') || action.startsWith('agent.')) {
    return { label: action, tone: destructive ? 'danger' : 'warning', icon: Cpu, known: false }
  }
  if (action.startsWith('user.')) {
    return { label: action, tone: destructive ? 'danger' : 'neutral', icon: User, known: false }
  }
  return { label: action, tone: destructive ? 'danger' : 'neutral', icon: Wrench, known: false }
}

/** 未登记中文名的动作直接显示原始 action，避免用「—」伪装成漏数据。 */
function actionTitle(action: string): string {
  return AUDIT_ACTION_META[action]?.label ?? action
}

function AuditActionBadge({ action }: { action: string }) {
  const meta = resolveAuditAction(action)
  const Icon = meta.icon
  return (
    <div className="min-w-0">
      <Badge
        variant="outline"
        className={cn('max-w-full gap-1.5 px-2 py-0.5 font-medium', TONE_BADGE_CLASS[meta.tone])}
      >
        <Icon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{meta.label}</span>
      </Badge>
      {meta.known ? (
        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
          {action}
        </span>
      ) : null}
    </div>
  )
}

function TargetTypeBadge({ targetType }: { targetType: string }) {
  const meta = TARGET_TYPE_META[targetType]
  const Icon = meta?.icon ?? Tag
  const tone = meta?.tone ?? 'neutral'
  return (
    <Badge
      variant="outline"
      title={meta ? targetType : undefined}
      className={cn('gap-1 px-1.5 py-0 text-[11px] font-medium', TONE_BADGE_CLASS[tone])}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span>{meta?.label ?? targetType}</span>
    </Badge>
  )
}

function OperatorCell({ operatorId }: { operatorId: string }) {
  const isCli = operatorId === 'cli'
  const Icon = isCli ? Terminal : User
  return (
    <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon
        className={cn('size-3.5 shrink-0', isCli ? 'text-info' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <ShortId value={operatorId} len={12} />
    </div>
  )
}

export function AuditPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [clock] = useState(() => Date.now())
  const preset = search.preset ?? 'all'
  const window =
    preset === 'custom' && search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : preset === 'today' || preset === '7d' || preset === '30d'
        ? presetWindow(preset, clock)
        : undefined
  const isMobile = useIsMobile()
  const query = useAudits({
    action: search.action,
    settingKey: search.settingKey,
    targetId: search.targetId,
    operatorId: search.operatorId,
    from: window?.from,
    to: window?.to,
  })
  const audits = query.data?.pages.flatMap((page) => page.audits) ?? []

  return (
    <Page crumbs={[{ label: '审计' }]} description="运营者执行过的写操作，只读">
      <FilterBar
        savedViewKey="audit"
        presets={['all', 'today', '7d', '30d', 'custom']}
        preset={preset}
        from={window?.from}
        to={window?.to}
        onPreset={(next, span) =>
          void navigate({
            search: (previous) => ({
              ...(previous ?? {}),
              preset: next,
              from: span?.from,
              to: span?.to,
            }),
            replace: true,
          })
        }
        search={search.operatorId ?? ''}
        searchPlaceholder="操作者 ID"
        onSearch={(operatorId) =>
          void navigate({
            search: (previous) => ({ ...(previous ?? {}), operatorId: operatorId || undefined }),
            replace: true,
          })
        }
        chips={auditChips(search)}
        definitions={[
          {
            key: 'action',
            label: '动作',
            kind: 'single',
            options: Object.entries(AUDIT_ACTION_META).map(([value, meta]) => ({
              value,
              label: meta.label,
            })),
          },
          { key: 'targetId', label: '对象 ID', kind: 'text' },
          { key: 'settingKey', label: '配置键', kind: 'text' },
        ]}
        values={{
          action: search.action ?? '',
          targetId: search.targetId ?? '',
          settingKey: search.settingKey ?? '',
        }}
        onChange={(key, value) =>
          void navigate({
            search: (previous) => ({ ...(previous ?? {}), [key]: value || undefined }),
            replace: true,
          })
        }
        onRemove={(key) =>
          void navigate({
            search: (previous) => ({ ...(previous ?? {}), [key]: undefined }),
            replace: true,
          })
        }
        onClear={() => void navigate({ search: {}, replace: true })}
      />
      {query.isPending ? (
        <PendingState label="加载审计记录" />
      ) : query.isError ? (
        <ErrorState label="加载审计记录失败" error={query.error} />
      ) : audits.length === 0 ? (
        <EmptyState label="没有匹配的审计记录" />
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-3">
              {audits.map((audit) => (
                <AuditCard key={audit.id} audit={audit} />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card/70 shadow-sm">
              <Table className="min-w-[880px]">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[104px] whitespace-nowrap pl-4 text-xs">时间</TableHead>
                    <TableHead className="w-[172px] whitespace-nowrap text-xs">操作者</TableHead>
                    <TableHead className="w-[240px] whitespace-nowrap text-xs">动作</TableHead>
                    <TableHead className="w-[220px] whitespace-nowrap text-xs">对象</TableHead>
                    <TableHead className="min-w-[240px] whitespace-nowrap pr-4 text-xs">
                      详情
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audits.map((audit) => {
                    const summary = detailText(audit.details)
                    return (
                      <TableRow key={audit.id}>
                        <TableCell className="whitespace-nowrap py-3 pl-4 align-top">
                          <FuzzyTime ts={audit.created_at} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-3 align-top">
                          <OperatorCell operatorId={audit.operator_id} />
                        </TableCell>
                        <TableCell className="max-w-[260px] py-3 align-top">
                          <AuditActionBadge action={audit.action} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-3 align-top">
                          <div className="flex flex-col items-start gap-1">
                            <TargetTypeBadge targetType={audit.target_type} />
                            <ShortId value={audit.target_id} len={16} />
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[380px] py-3 pr-4 align-top">
                          <span
                            title={summary !== '—' ? summary : undefined}
                            className="block truncate font-mono text-xs text-muted-foreground"
                          >
                            {summary}
                          </span>
                          <AuditDiff details={audit.details} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}

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

function AuditCard({ audit }: { audit: OperatorAuditRow }) {
  return (
    <article className="min-w-0 rounded-xl border bg-card/70 p-4 shadow-sm">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <AuditActionBadge action={audit.action} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          <FuzzyTime ts={audit.created_at} />
        </span>
      </header>
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 border-t pt-3 text-xs">
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            操作者
          </dt>
          <dd className="mt-1 min-w-0">
            <OperatorCell operatorId={audit.operator_id} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            对象
          </dt>
          <dd className="mt-1 flex min-w-0 flex-col items-start gap-1">
            <TargetTypeBadge targetType={audit.target_type} />
            <ShortId value={audit.target_id} len={12} />
          </dd>
        </div>
      </dl>
      <div className="mt-3 break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <p>{detailText(audit.details)}</p>
        <AuditDiff details={audit.details} />
      </div>
    </article>
  )
}

function auditChips(search: {
  action?: string
  targetId?: string
  settingKey?: string
}): FilterChip[] {
  const chips: FilterChip[] = []
  if (search.action) chips.push({ key: 'action', label: '动作', value: actionTitle(search.action) })
  if (search.targetId) chips.push({ key: 'targetId', label: '对象', value: search.targetId })
  if (search.settingKey)
    chips.push({ key: 'settingKey', label: '配置键', value: search.settingKey })
  return chips
}

function AuditDiff({ details }: { details: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  if (!('before' in details) || !('after' in details)) return null
  const before = details.before
  const after = details.after
  const keys =
    before && after && typeof before === 'object' && typeof after === 'object'
      ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
      : []
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="mt-1.5"
        onClick={() => setOpen(true)}
      >
        <ArrowLeftRight className="size-3" aria-hidden="true" />
        对比
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>变更对比</DialogTitle>
          </DialogHeader>
          {keys.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>字段</TableHead>
                  <TableHead>之前</TableHead>
                  <TableHead>之后</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-xs">{key}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {JSON.stringify((before as Record<string, unknown>)[key] ?? null)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {JSON.stringify((after as Record<string, unknown>)[key] ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(before, null, 2)}
              </pre>
              <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(after, null, 2)}
              </pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
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
