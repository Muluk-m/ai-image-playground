import type {
  Catalog,
  MembershipTier,
  OperatorPurchaseOrder,
  OrderConfirmation,
  PurchaseOrderStatus,
} from '@image-playground/shared'
import { rankedPlanIds, tierOf } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  BellOff,
  CalendarClock,
  CheckCircle2,
  Clock,
  Coins,
  FileSearch,
  History,
  type LucideIcon,
  MailCheck,
  MailX,
  ReceiptText,
  RefreshCw,
  Repeat,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  TimerOff,
  User,
  X,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { DateTimePicker } from '@/components/DateTimePicker'
import { SegmentedControl } from '@/components/SegmentedControl'
import { ShortId } from '@/components/ShortId'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ApiError, apiClient } from '../../lib/private-host'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '../../lib/private-host-ui'
import { dateTime, money, parseLocalInput } from './shared'
import TierBadge, { TIER_COLORS } from './TierBadge'

interface StatusMeta {
  label: string
  badgeClass: string
  icon: LucideIcon
}

const ORDER_STATUS_META: Record<PurchaseOrderStatus, StatusMeta> = {
  pending: {
    label: '待付款',
    badgeClass: 'border-info/25 bg-info/15 text-info',
    icon: Clock,
  },
  review: {
    label: '待核款',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    icon: ShieldAlert,
  },
  completed: {
    label: '已完成',
    badgeClass: 'border-success/25 bg-success/15 text-success',
    icon: CheckCircle2,
  },
  rejected: {
    label: '核款未通过',
    badgeClass: 'border-danger/25 bg-danger/15 text-danger',
    icon: XCircle,
  },
  cancelled: {
    label: '已取消',
    badgeClass: 'border-border bg-muted text-muted-foreground',
    icon: Ban,
  },
  expired: {
    label: '已过期',
    badgeClass: 'border-border bg-muted text-muted-foreground',
    icon: TimerOff,
  },
}

const NOTIFICATION_META: Record<OperatorPurchaseOrder['notification_status'], StatusMeta> = {
  none: {
    label: '未触发',
    badgeClass: 'border-border bg-muted/60 text-muted-foreground',
    icon: BellOff,
  },
  pending: {
    label: '待发送',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    icon: Clock,
  },
  claimed: {
    label: '发送中',
    badgeClass: 'border-info/25 bg-info/15 text-info',
    icon: Send,
  },
  sent: {
    label: '已发送',
    badgeClass: 'border-success/25 bg-success/15 text-success',
    icon: MailCheck,
  },
  failed: {
    label: '发送失败',
    badgeClass: 'border-danger/25 bg-danger/15 text-danger',
    icon: MailX,
  },
  unknown: {
    label: '结果未知',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    icon: AlertTriangle,
  },
}

const SUBSCRIPTION_ACTION_META: Record<
  NonNullable<OperatorPurchaseOrder['subscription_action']>,
  { label: string; detailLabel: string; badgeClass: string; icon: LucideIcon }
> = {
  grant: {
    label: '开通',
    detailLabel: '开通',
    badgeClass: 'border-success/25 bg-success/15 text-success',
    icon: Sparkles,
  },
  renew: {
    label: '续期',
    detailLabel: '续期',
    badgeClass: 'border-border bg-secondary text-secondary-foreground',
    icon: Repeat,
  },
  upgrade: {
    label: '立即升档',
    detailLabel: '核款后立即升档',
    badgeClass: 'border-info/25 bg-info/15 text-info',
    icon: ArrowUpRight,
  },
  schedule: {
    label: '到期后换档',
    detailLabel: '当前套餐到期后生效',
    badgeClass: 'border-warning/25 bg-warning/15 text-warning',
    icon: CalendarClock,
  },
}

const ORDER_FILTER_OPTIONS = [
  { value: 'open', label: '待付款 / 待核款' },
  { value: 'all', label: '最近订单' },
] as const

type OrderFilter = (typeof ORDER_FILTER_OPTIONS)[number]['value']

function resolveOrderTier(
  order: OperatorPurchaseOrder,
  catalog: Catalog | undefined,
): MembershipTier {
  const activePlans = (catalog?.plans ?? []).filter((plan) => plan.active)
  const ranked = rankedPlanIds(activePlans)
  if (order.plan_id && ranked.includes(order.plan_id)) {
    return tierOf(order.plan_id, ranked)
  }
  const byName = order.plan_name
    ? activePlans.find((plan) => plan.name === order.plan_name)
    : undefined
  if (byName) return tierOf(byName.id, ranked)
  return tierOf(order.plan_id, ranked)
}

function OrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const meta = ORDER_STATUS_META[status]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('gap-1.5 px-2 py-0.5 font-medium', meta.badgeClass)}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </Badge>
  )
}

function NotificationStatusBadge({
  status,
}: {
  status: OperatorPurchaseOrder['notification_status']
}) {
  const meta = NOTIFICATION_META[status]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('gap-1.5 px-2 py-0.5 font-medium', meta.badgeClass)}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </Badge>
  )
}

function OrderItemCell({
  order,
  tier,
  detailed = false,
}: {
  order: OperatorPurchaseOrder
  tier: MembershipTier
  detailed?: boolean
}) {
  if (order.kind === 'recharge') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="gap-1 border-private/25 bg-private/10 px-2 py-0.5 font-medium text-private"
        >
          <Coins className="size-3 shrink-0" aria-hidden="true" />
          积分充值
        </Badge>
        <span className="font-mono text-xs font-medium tabular-nums text-foreground">
          {order.recharge_credits?.toLocaleString()} 积分
        </span>
      </div>
    )
  }

  const actionMeta = order.subscription_action
    ? SUBSCRIPTION_ACTION_META[order.subscription_action]
    : null
  const ActionIcon = actionMeta?.icon

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <TierBadge tier={tier} size={15} aria-hidden />
        <span style={{ color: TIER_COLORS[tier] }}>{order.plan_name ?? '会员套餐'}</span>
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{order.period_months} 个月</span>
      {actionMeta && ActionIcon ? (
        <Badge
          variant="outline"
          className={cn('gap-1 px-1.5 py-0 text-[11px] font-medium', actionMeta.badgeClass)}
        >
          <ActionIcon className="size-3 shrink-0" aria-hidden="true" />
          {detailed ? actionMeta.detailLabel : actionMeta.label}
        </Badge>
      ) : null}
    </div>
  )
}

function errorText(error: unknown) {
  if (
    error instanceof ApiError &&
    typeof error.body === 'object' &&
    error.body &&
    'error' in error.body
  ) {
    const code = String(error.body.error)
    const messages: Record<string, string> = {
      receipt_amount_mismatch: '实收金额与订单不符，请核对。',
      receipt_account_mismatch: '渠道或收款账户不匹配。',
      receipt_already_used: '此交易已关联其他订单，请勿重复确认。',
      order_requires_reopen: '请先填写原因重新受理原订单。',
      late_payment_requires_reopen: '付款超出有效期，请记录原因后重新受理。',
      active_subscription_plan_mismatch: '用户套餐已发生变化，请人工核对。',
      scheduled_plan_change_exists: '已有待生效的换档，当前套餐到期前不能再购买其他档位。',
      invalid_receipt: '请核对收款账户和实收金额。',
    }
    return messages[code] ?? '操作未完成，请刷新核对后重试。'
  }
  return '操作未完成，请刷新核对后重试。'
}

export function OrdersPanel() {
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get('order') ?? '',
  )
  const userFilter = new URLSearchParams(window.location.search).get('user')
  const [amount, setAmount] = useState('')
  const [time, setTime] = useState('')
  const [search, setSearch] = useState(
    query
      ? `?q=${encodeURIComponent(query)}`
      : userFilter
        ? `?user_id=${encodeURIComponent(userFilter)}`
        : '',
  )
  const [selected, setSelected] = useState<string | null>(query || null)
  const [filter, setFilter] = useState<OrderFilter>('open')

  const result = useQuery({
    queryKey: ['private-orders', search, filter],
    queryFn: () =>
      apiClient.get<{ orders: OperatorPurchaseOrder[] }>(
        `/api/private/billing/orders${search || (filter === 'open' ? '?state=open' : '')}`,
      ),
    refetchInterval: 10000,
  })
  const catalog = useQuery({
    queryKey: ['private-billing', 'catalog'],
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
    staleTime: 60_000,
  })

  const rows = useMemo(
    () =>
      result.data?.orders.filter(
        (o) => search || filter === 'all' || ['pending', 'review'].includes(o.status),
      ) ?? [],
    [result.data, search, filter],
  )

  const hasSearchInput = Boolean(query.trim() || amount || time || search)

  function clearSearch() {
    setQuery('')
    setAmount('')
    setTime('')
    setSearch('')
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ReceiptText className="size-4 text-muted-foreground" aria-hidden="true" />
            从收款记录找订单
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form
            className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            onSubmit={(e) => {
              e.preventDefault()
              const params = new URLSearchParams()
              if (query.trim()) params.set('q', query.trim())
              if (amount) params.set('amount_cents', String(Math.round(Number(amount) * 100)))
              if (time) params.set('received_at', String(parseLocalInput(time)))
              const encoded = params.toString()
              setSearch(encoded ? `?${encoded}` : '')
            }}
          >
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="订单码或订单号"
                placeholder="订单码 / 订单号"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Input
              aria-label="实收金额"
              placeholder="实收金额（元）"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <DateTimePicker
              aria-label="大致到账时间"
              placeholder="大致到账时间"
              value={time}
              onChange={setTime}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" className="flex-1 md:flex-none">
                <Search className="size-4" aria-hidden="true" />
                查找
              </Button>
              {hasSearchInput ? (
                <Button type="button" variant="outline" onClick={clearSearch}>
                  <X className="size-4" aria-hidden="true" />
                  清空
                </Button>
              ) : null}
            </div>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            无备注时按金额和到账时间找候选，再核对交易号；候选不代表匹配成功。
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="订单状态筛选"
            options={ORDER_FILTER_OPTIONS}
            value={search ? '' : filter}
            onChange={(next) => {
              setFilter(next)
              clearSearch()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={result.isFetching}
            onClick={() => void result.refetch()}
          >
            <RefreshCw
              className={cn('size-3.5', result.isFetching && 'animate-spin')}
              aria-hidden="true"
            />
            刷新
          </Button>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">共 {rows.length} 条订单</span>
      </div>

      {result.isError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          订单读取失败，请重试。
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border bg-card/70 shadow-sm">
        <Table className="min-w-[820px]">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead className="whitespace-nowrap pl-4 text-xs">订单 / 用户</TableHead>
              <TableHead className="whitespace-nowrap text-xs">套餐 / 商品</TableHead>
              <TableHead className="w-[104px] whitespace-nowrap text-right text-xs">应收</TableHead>
              <TableHead className="w-[128px] whitespace-nowrap text-center text-xs">
                状态
              </TableHead>
              <TableHead className="w-[116px] whitespace-nowrap text-center text-xs">
                通知
              </TableHead>
              <TableHead className="w-[136px] whitespace-nowrap pr-4 text-right text-xs">
                操作
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const tier = resolveOrderTier(o, catalog.data)
              const isSelected = selected === o.id
              return (
                <TableRow
                  key={o.id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(isSelected && 'bg-muted/60')}
                >
                  <TableCell className="py-3 pl-4 align-top">
                    <ShortId value={o.code} len={16} className="font-semibold" />
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-foreground">
                      <User className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{o.username}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {dateTime(o.created_at)}
                    </div>
                  </TableCell>
                  <TableCell className="py-3 align-middle">
                    <OrderItemCell order={o} tier={tier} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 text-right align-middle font-mono font-semibold tabular-nums">
                    {money(o.amount_cents)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 text-center align-middle">
                    <OrderStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 text-center align-middle">
                    <NotificationStatusBadge status={o.notification_status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 pr-4 text-right align-middle">
                    <Button size="sm" variant="outline" onClick={() => setSelected(o.id)}>
                      <FileSearch className="size-3.5" aria-hidden="true" />
                      查看 / 核款
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {!rows.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {result.isLoading ? '正在读取…' : '暂无符合条件的订单'}
          </p>
        ) : null}
      </div>

      {selected ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
        >
          <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[576px]">
            <OrderDetail
              key={selected}
              id={selected}
              catalog={catalog.data}
              onClose={() => setSelected(null)}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}

function OrderDetail({
  id,
  catalog,
  onClose,
}: {
  id: string
  catalog: Catalog | undefined
  onClose: () => void
}) {
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['private-order', id],
    queryFn: () => apiClient.get<OperatorPurchaseOrder>(`/api/private/billing/orders/${id}`),
  })
  const [note, setNote] = useState('')
  const [rejection, setRejection] = useState('')
  const [amount, setAmount] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [verified, setVerified] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const order = detail.data

  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: string; body: unknown }) =>
      apiClient.post(`/api/private/billing/orders/${id}/${action}`, body),
    onSuccess: async () => {
      setVerified(false)
      await Promise.all([
        client.invalidateQueries({ queryKey: ['private-orders'] }),
        client.invalidateQueries({ queryKey: ['private-order', id] }),
        client.invalidateQueries({ queryKey: ['private-billing'] }),
      ])
    },
  })

  if (!order) {
    return (
      <>
        <SheetHeader className="border-b px-6 py-4 pr-12">
          <SheetTitle className="text-base">订单详情</SheetTitle>
          <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
        </SheetHeader>
        <div className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <span>{detail.isError ? '订单读取失败' : '正在读取…'}</span>
          {detail.isError ? (
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              重试
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </>
    )
  }

  const tier = resolveOrderTier(order, catalog)
  const version = order.payment_history.find((v) => v.id === code) ?? order.payment_code
  const canConfirm = order.status === 'review' || order.status === 'pending'
  const review = (action: 'note' | 'reject' | 'reopen') => {
    setConfirmReject(false)
    mutation.mutate({ action: 'review', body: { action, note, rejection_message: rejection } })
  }
  const conflict =
    mutation.error instanceof ApiError &&
    typeof mutation.error.body === 'object' &&
    mutation.error.body &&
    'order_id' in mutation.error.body
      ? String(mutation.error.body.order_id)
      : null

  return (
    <>
      <SheetHeader className="border-b px-6 py-4 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="font-mono text-lg">{order.code}</SheetTitle>
          <OrderStatusBadge status={order.status} />
          <NotificationStatusBadge status={order.notification_status} />
        </div>
        <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 text-foreground">
            <User className="size-3 text-muted-foreground" aria-hidden="true" />
            {order.username}
          </span>
          <span>·</span>
          <span className="font-mono">{order.user_id}</span>
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <div className="rounded-xl border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <OrderItemCell order={order} tier={tier} detailed />
            <span className="font-mono text-lg font-semibold tabular-nums">
              {money(order.amount_cents)}
            </span>
          </div>
          <dl className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd className="mt-0.5 font-mono tabular-nums">{dateTime(order.created_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">申报时间</dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {order.claimed_at ? dateTime(order.claimed_at) : '尚未申报'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">付款期限</dt>
              <dd className="mt-0.5 font-mono tabular-nums">{dateTime(order.expires_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">订单 ID</dt>
              <dd className="mt-0.5">
                <ShortId value={order.id} len={18} />
              </dd>
            </div>
          </dl>
        </div>

        {order.review_note ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">{order.review_note}</div>
        ) : null}

        {order.receipt ? (
          <div className="space-y-1 rounded-lg border border-success/25 bg-success/5 p-4 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-success">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
              {order.receipt.transaction_id
                ? `交易号：${order.receipt.transaction_id}`
                : '人工确认收款'}
            </p>
            <p className="text-xs text-muted-foreground">
              收款账户：{order.receipt.receiving_account}
            </p>
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              实收：{money(order.receipt.amount_cents)} ·{' '}
              {order.receipt.received_at_source === 'confirmation' ? '确认时间：' : '到账时间：'}
              {dateTime(order.receipt.received_at)}
            </p>
          </div>
        ) : null}

        {canConfirm ? (
          <form
            className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!verified) return
              const receipt: OrderConfirmation = {
                channel: version.channel,
                receiving_account: version.account,
                payment_code_id: version.id,
                amount_cents: Math.round(Number(amount ?? order.amount_cents / 100) * 100),
                note,
              }
              mutation.mutate({ action: 'confirm', body: receipt })
            }}
          >
            <label className="space-y-1.5 text-sm">
              <span>收款码 / 账户</span>
              <Select value={code || order.payment_code.id} onValueChange={setCode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {order.payment_history.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.channel === 'wechat' ? '微信' : '支付宝'} · {v.account} ·{' '}
                      {v.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span>实收金额（元）</span>
              <Input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={amount ?? (order.amount_cents / 100).toFixed(2)}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              确认收款时自动记录时间，无需填写交易号。
            </p>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={verified} onCheckedChange={setVerified} />
              已在收款工具中核对账户、金额与付款人，确认已到账
            </label>
            <Button
              variant="brand"
              disabled={!verified || mutation.isPending}
              type="submit"
              className="sm:col-span-2"
            >
              <CheckCircle2 className="size-4" aria-hidden="true" />
              {mutation.isPending ? '正在确认收款…' : '确认收款'}
            </Button>
          </form>
        ) : null}

        <div className="space-y-3">
          <label className="block space-y-2 text-sm">
            <span>核对备注 / 处置原因</span>
            <Textarea
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="未匹配原因、联系结果或迟到付款处理说明"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!note.trim() || mutation.isPending}
              variant="outline"
              onClick={() => review('note')}
            >
              保存备注
            </Button>
            {['expired', 'cancelled', 'rejected'].includes(order.status) ? (
              <Button
                disabled={!note.trim() || mutation.isPending}
                onClick={() => review('reopen')}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                重新受理原订单
              </Button>
            ) : null}
          </div>
          {order.status === 'review' ? (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
              <label className="min-w-[200px] flex-1 space-y-1.5 text-sm">
                <span>告知用户的拒绝原因</span>
                <Input
                  value={rejection}
                  onChange={(e) => setRejection(e.target.value)}
                  maxLength={1000}
                  placeholder="填写将展示给用户的拒绝说明"
                />
              </label>
              <Button
                disabled={!note.trim() || !rejection.trim() || mutation.isPending}
                title={!note.trim() || !rejection.trim() ? '请先填写核对备注与拒绝原因' : undefined}
                variant="destructive"
                onClick={() => {
                  if (!confirmReject) {
                    setConfirmReject(true)
                    return
                  }
                  review('reject')
                }}
              >
                <XCircle className="size-4" aria-hidden="true" />
                {confirmReject ? '确认拒绝本次申报' : '拒绝本次申报'}
              </Button>
              {confirmReject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => setConfirmReject(false)}
                >
                  取消
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(mutation.error)}
            {conflict ? (
              <a
                className="ml-2 underline"
                href={`/billing/orders?order=${encodeURIComponent(conflict)}`}
              >
                查看已关联订单
              </a>
            ) : null}
          </p>
        ) : null}
        {mutation.isSuccess ? (
          <p role="status" className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            已保存
          </p>
        ) : null}

        {order.history.length ? (
          <div className="space-y-2 border-t pt-4">
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <History className="size-3.5" aria-hidden="true" />
              操作记录
            </h4>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              {order.history.map((h, i) => (
                <p key={`${h.at}-${i}`} className="font-mono tabular-nums">
                  {dateTime(h.at)} · {h.operator_id} · {h.action}
                  {h.note ? ` · ${h.note}` : ''}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
