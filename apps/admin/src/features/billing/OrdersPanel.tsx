import type { OperatorPurchaseOrder, OrderConfirmation } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

const labels = {
  pending: '待付款',
  review: '待核款',
  completed: '已完成',
  rejected: '核款未通过',
  cancelled: '已取消',
  expired: '已过期',
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
  const [amount, setAmount] = useState(''),
    [time, setTime] = useState(''),
    [search, setSearch] = useState(
      query
        ? `?q=${encodeURIComponent(query)}`
        : userFilter
          ? `?user_id=${encodeURIComponent(userFilter)}`
          : '',
    )
  const [selected, setSelected] = useState<string | null>(query || null),
    [filter, setFilter] = useState('open')
  const result = useQuery({
    queryKey: ['private-orders', search, filter],
    queryFn: () =>
      apiClient.get<{ orders: OperatorPurchaseOrder[] }>(
        `/api/private/billing/orders${search || (filter === 'open' ? '?state=open' : '')}`,
      ),
    refetchInterval: 10000,
  })
  const rows =
    result.data?.orders.filter(
      (o) => search || filter === 'all' || ['pending', 'review'].includes(o.status),
    ) ?? []
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">订单核款</h1>
        <p className="mt-1 text-sm text-muted-foreground">对照收款记录，确认到账后续期。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>从收款记录找订单</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault()
              const params = new URLSearchParams()
              if (query.trim()) params.set('q', query.trim())
              if (amount) params.set('amount_cents', String(Math.round(Number(amount) * 100)))
              if (time) params.set('received_at', String(parseLocalInput(time)))
              setSearch(`?${params}`)
            }}
          >
            <Input
              aria-label="订单码或订单号"
              placeholder="订单码 / 订单号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Input
              aria-label="实收金额"
              placeholder="实收金额（元）"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Input
              aria-label="大致到账时间"
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
            <Button type="submit">查找</Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            无备注时按金额和到账时间找候选，再核对交易号；候选不代表匹配成功。
          </p>
        </CardContent>
      </Card>
      <div className="flex gap-3">
        <Button
          variant={filter === 'open' ? 'default' : 'outline'}
          onClick={() => {
            setFilter('open')
            setSearch('')
          }}
        >
          待付款 / 待核款
        </Button>
        <Button
          variant={filter === 'all' ? 'default' : 'outline'}
          onClick={() => {
            setFilter('all')
            setSearch('')
          }}
        >
          最近订单
        </Button>
        <Button variant="outline" onClick={() => void result.refetch()}>
          刷新
        </Button>
      </div>
      {result.isError ? (
        <p role="alert" className="text-destructive">
          订单读取失败，请重试。
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted">
            <tr>
              {['订单 / 用户', '套餐', '应收', '状态', '通知', '操作'].map((t) => (
                <th key={t} className="p-3">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="p-3">
                  <strong className="font-mono">{o.code}</strong>
                  <div>{o.username}</div>
                  <small className="text-muted-foreground">{dateTime(o.created_at)}</small>
                </td>
                <td className="p-3">
                  {o.kind === 'recharge'
                    ? `积分充值 · ${o.recharge_credits?.toLocaleString()} 积分`
                    : `${o.plan_name} · ${o.period_months} 个月${
                        o.subscription_action === 'schedule'
                          ? ' · 到期后换档'
                          : o.subscription_action === 'upgrade'
                            ? ' · 立即升档'
                            : o.subscription_action === 'grant'
                              ? ' · 开通'
                              : ''
                      }`}
                </td>
                <td className="p-3">{money(o.amount_cents)}</td>
                <td className="p-3">{labels[o.status]}</td>
                <td
                  className={`p-3 ${['failed', 'unknown'].includes(o.notification_status) ? 'text-destructive' : ''}`}
                >
                  {
                    {
                      none: '—',
                      pending: '待发送',
                      claimed: '发送中',
                      sent: '已发送',
                      failed: '发送失败',
                      unknown: '结果未知',
                    }[o.notification_status]
                  }
                </td>
                <td className="p-3">
                  <Button size="sm" variant="outline" onClick={() => setSelected(o.id)}>
                    查看 / 核款
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <p className="p-8 text-center text-muted-foreground">
            {result.isLoading ? '正在读取…' : '暂无符合条件的订单'}
          </p>
        ) : null}
      </div>
      {selected ? (
        <OrderDetail key={selected} id={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  )
}
function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['private-order', id],
    queryFn: () => apiClient.get<OperatorPurchaseOrder>(`/api/private/billing/orders/${id}`),
  })
  const [note, setNote] = useState(''),
    [rejection, setRejection] = useState(''),
    [amount, setAmount] = useState<string | null>(null),
    [code, setCode] = useState(''),
    [verified, setVerified] = useState(false)
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
  if (!order)
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6">
          <span>{detail.isError ? '订单读取失败' : '正在读取…'}</span>
          {detail.isError ? (
            <Button variant="outline" onClick={() => void detail.refetch()}>
              重试
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </CardContent>
      </Card>
    )
  const version = order.payment_history.find((v) => v.id === code) ?? order.payment_code
  const canConfirm = order.status === 'review' || order.status === 'pending'
  const review = (action: 'note' | 'reject' | 'reopen') =>
    mutation.mutate({ action: 'review', body: { action, note, rejection_message: rejection } })
  const conflict =
    mutation.error instanceof ApiError &&
    typeof mutation.error.body === 'object' &&
    mutation.error.body &&
    'order_id' in mutation.error.body
      ? String(mutation.error.body.order_id)
      : null
  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between">
          <CardTitle>
            {order.code} · {labels[order.status]}
          </CardTitle>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <p>
            {order.username} · {order.user_id}
          </p>
          <p>
            {order.kind === 'recharge'
              ? `积分充值 · ${order.recharge_credits?.toLocaleString()} 积分`
              : `${order.plan_name} · ${order.period_months} 个月${
                  order.subscription_action === 'schedule'
                    ? ' · 当前套餐到期后生效'
                    : order.subscription_action === 'upgrade'
                      ? ' · 核款后立即升档'
                      : order.subscription_action === 'grant'
                        ? ' · 开通'
                        : ''
                }`}{' '}
            · {money(order.amount_cents)}
          </p>
          <p>创建：{dateTime(order.created_at)}</p>
          <p>申报：{order.claimed_at ? dateTime(order.claimed_at) : '尚未申报'}</p>
          <p className="break-all">订单：{order.id}</p>
          <p>付款期限：{dateTime(order.expires_at)}</p>
        </div>
        {order.review_note ? (
          <p className="rounded-lg bg-muted p-3 text-sm">{order.review_note}</p>
        ) : null}
        {order.receipt ? (
          <div className="rounded-lg bg-muted p-4 text-sm">
            <p>
              {order.receipt.transaction_id
                ? `交易号：${order.receipt.transaction_id}`
                : '人工确认收款'}
            </p>
            <p>收款账户：{order.receipt.receiving_account}</p>
            <p>
              实收：{money(order.receipt.amount_cents)} ·{' '}
              {order.receipt.received_at_source === 'confirmation' ? '确认时间：' : '到账时间：'}
              {dateTime(order.receipt.received_at)}
            </p>
          </div>
        ) : null}
        {canConfirm ? (
          <form
            className="grid gap-4 sm:grid-cols-2"
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
            <label className="space-y-1 text-sm">
              收款码 / 账户
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
            <label className="space-y-1 text-sm">
              实收金额（元）
              <Input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={amount ?? (order.amount_cents / 100).toFixed(2)}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              确认收款时自动记录时间，无需填写交易号。
            </p>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={verified} onCheckedChange={setVerified} />
              已在收款工具中核对账户、金额与付款人，确认已到账
            </label>
            <Button disabled={!verified || mutation.isPending} type="submit">
              {mutation.isPending ? '正在确认收款…' : '确认收款'}
            </Button>
          </form>
        ) : null}
        <label className="block space-y-2 text-sm">
          核对备注 / 处置原因
          <Textarea
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="未匹配原因、联系结果或迟到付款处理说明"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!note.trim() || mutation.isPending}
            variant="outline"
            onClick={() => review('note')}
          >
            保存备注
          </Button>
          {order.status === 'review' ? (
            <>
              <label className="text-sm">
                告知用户的拒绝原因
                <Input
                  value={rejection}
                  onChange={(e) => setRejection(e.target.value)}
                  maxLength={1000}
                />
              </label>
              <Button
                disabled={!note.trim() || !rejection.trim() || mutation.isPending}
                variant="destructive"
                onClick={() => review('reject')}
              >
                拒绝本次申报
              </Button>
            </>
          ) : null}
          {['expired', 'cancelled', 'rejected'].includes(order.status) ? (
            <Button disabled={!note.trim() || mutation.isPending} onClick={() => review('reopen')}>
              重新受理原订单
            </Button>
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
          <p role="status" className="text-sm text-emerald-600">
            已保存
          </p>
        ) : null}
        <div className="space-y-2 text-xs text-muted-foreground">
          {order.history.map((h, i) => (
            <p key={`${h.at}-${i}`}>
              {dateTime(h.at)} · {h.operator_id} · {h.action} · {h.note}
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
