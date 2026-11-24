import type { PurchaseOrder } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { copyTextToClipboard } from '../../lib/clipboard'
import { Button, Dialog, DialogSurface, Icon, Overlay } from '../../lib/privateHost'
import { formatCredits, formatMoney, refreshBillingAfterSettlement } from './billing-store'
import { tBilling, useTranslation } from './i18n'
import { orderRequest } from './orders-client'

export function PaymentSurface({
  order,
  busy,
  onAction,
  onClose,
  now,
  confirmClaim = false,
  confirmCancel = false,
}: {
  order: PurchaseOrder
  busy: boolean
  onAction: (action: string) => void
  onClose: () => void
  now: number
  confirmClaim?: boolean
  confirmCancel?: boolean
}) {
  useTranslation()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )
  const copyRemark = async () => {
    try {
      await copyTextToClipboard(order.code)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }
  const pending = order.status === 'pending' && order.expires_at > now
  const payable = pending && order.payment_available
  const status = order.status === 'pending' && !pending ? 'expired' : order.status
  return (
    <DialogSurface
      title={
        order.kind === 'recharge'
          ? tBilling('action.recharge')
          : `${order.plan_name} · ${tBilling(
              order.subscription_action === 'grant'
                ? 'membership.subscribe'
                : order.subscription_action === 'upgrade'
                  ? 'membership.upgrade'
                  : order.subscription_action === 'schedule'
                    ? 'orders.changePlan'
                    : 'orders.renewal',
            )}`
      }
      onClose={onClose}
      className="max-w-lg"
    >
      <div className="mt-2 text-center">
        <strong className="text-headline font-semibold tracking-tight">
          {formatMoney(order.amount_cents)}
        </strong>
        <span className="ml-3 text-muted-foreground">
          {order.kind === 'recharge'
            ? tBilling('recharge.credits', { n: formatCredits(order.recharge_credits ?? 0) })
            : tBilling('orders.months', { n: order.period_months })}
        </span>
      </div>
      {payable ? (
        <>
          <div className="mt-2 rounded-xl bg-primary/10 p-2 text-center">
            <div className="text-xs text-muted-foreground">{tBilling('orders.remark')}</div>
            <Button
              type="button"
              onClick={() => void copyRemark()}
              variant="ghost"
              size="lg"
              className="mt-1 font-mono"
            >
              <span className="text-xl font-semibold tracking-widest">{order.code}</span>
              <Icon name={copyState === 'copied' ? 'check' : 'copy'} />
              <span>
                {tBilling(
                  copyState === 'copied'
                    ? 'orders.copied'
                    : copyState === 'failed'
                      ? 'orders.copyFailed'
                      : 'orders.copy',
                )}
              </span>
            </Button>
          </div>
          <img
            src={order.payment_code.url}
            alt={tBilling('contact.paymentQr')}
            className="mx-auto mt-2 h-52 w-52 rounded-2xl bg-on-media p-2 object-contain"
          />
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {tBilling(
              order.payment_code.channel === 'wechat' ? 'orders.scanWechat' : 'orders.scanAlipay',
            )}
          </p>
          <p data-payment-countdown className="mt-1 text-center text-xs text-muted-foreground">
            {tBilling('orders.remaining', { n: Math.ceil((order.expires_at - now) / 60_000) })}
          </p>
        </>
      ) : (
        <div
          role="status"
          className="my-6 rounded-2xl border border-border bg-muted/40 p-6 text-center"
        >
          <h3 className="text-base font-medium">
            {tBilling(pending ? 'orders.paused' : `orders.status.${status}`)}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {tBilling(
              status === 'completed'
                ? order.subscription_action === 'schedule'
                  ? 'orders.completeScheduled'
                  : order.subscription_action === 'upgrade'
                    ? 'orders.completeUpgrade'
                    : order.subscription_action === 'grant'
                      ? 'orders.completeGrant'
                      : 'orders.completeHint'
                : 'orders.noRepay',
            )}
          </p>
          {order.review_note ? <p className="mt-3 text-sm">{order.review_note}</p> : null}
        </div>
      )}
      {(order.subscription_action === 'schedule' || order.subscription_action === 'upgrade') &&
      status !== 'completed' ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          {tBilling(
            order.subscription_action === 'upgrade'
              ? 'orders.upgradeEffective'
              : 'orders.changeEffective',
          )}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border p-2">
        <div>
          <p className="text-sm font-medium">{tBilling('orders.help')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{tBilling('orders.helpHint')}</p>
          {!order.contact_qr_url ? <p className="text-sm">{order.contact_wechat}</p> : null}
        </div>
        {order.contact_qr_url ? (
          <img
            src={order.contact_qr_url}
            alt={tBilling('contact.wechatQrAlt')}
            className="h-16 w-16 shrink-0 rounded bg-on-media p-1 object-contain"
          />
        ) : null}
      </div>
      {pending ? (
        <div className="mt-2 space-y-2">
          {confirmClaim ? (
            <p role="status" className="text-sm text-muted-foreground">
              {tBilling('orders.claimReminder', { code: order.code })}
            </p>
          ) : null}
          <Button
            disabled={busy}
            type="button"
            className="w-full"
            onClick={() => onAction(confirmClaim ? 'confirm-claim' : 'claim')}
          >
            {tBilling(confirmClaim ? 'orders.confirmClaim' : 'orders.claim')}
          </Button>
          {!order.payment_available ? (
            <Button
              disabled={busy}
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => onAction('refresh-code')}
            >
              {tBilling('orders.refreshCode')}
            </Button>
          ) : null}
          {confirmCancel ? (
            <p role="status" className="text-sm text-destructive">
              {tBilling('orders.cancelReminder')}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={busy}
              type="button"
              variant={confirmCancel ? 'destructive' : 'ghost'}
              className={
                confirmCancel ? 'flex-1' : 'flex-1 text-muted-foreground hover:text-destructive'
              }
              onClick={() => onAction(confirmCancel ? 'confirm-cancel' : 'cancel')}
            >
              {tBilling(confirmCancel ? 'orders.confirmCancel' : 'orders.cancel')}
            </Button>
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              {tBilling('orders.later')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" className="mt-4 w-full" onClick={onClose}>
          {tBilling('orders.close')}
        </Button>
      )}
      <p className="mt-1 break-all text-center font-mono text-label-sm text-muted-foreground">
        {order.id}
      </p>
    </DialogSurface>
  )
}
export function PaymentPanel({
  initial,
  onClose,
}: {
  initial: PurchaseOrder
  onClose: () => void
}) {
  const [order, setOrder] = useState(initial),
    [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [confirmClaim, setConfirmClaim] = useState(false),
    [confirmCancel, setConfirmCancel] = useState(false)
  useTranslation()
  const sequence = useRef(0)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const attempt = ++sequence.current
      try {
        const next = await orderRequest<PurchaseOrder>(`/${initial.id}`)
        if (alive && attempt === sequence.current) {
          setOrder(next)
          setError(false)
        }
      } catch {
        if (alive) setError(true)
      }
    }
    void refresh()
    const poll = setInterval(() => void refresh(), 5000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      alive = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [initial.id])
  useEffect(() => {
    if (order.status === 'completed') void refreshBillingAfterSettlement()
  }, [order.status])
  const act = async (action: string) => {
    if (action === 'claim') {
      setConfirmCancel(false)
      setConfirmClaim(true)
      return
    }
    if (action === 'cancel') {
      setConfirmClaim(false)
      setConfirmCancel(true)
      return
    }
    setBusy(true)
    setError(false)
    ++sequence.current
    try {
      const endpoint =
        action === 'confirm-claim' ? 'claim' : action === 'confirm-cancel' ? 'cancel' : action
      const next = await orderRequest<PurchaseOrder>(`/${order.id}/${endpoint}`, {})
      ++sequence.current
      setOrder(next)
      setConfirmClaim(false)
      setConfirmCancel(false)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Overlay onClose={onClose} role="none">
      <div className="w-full max-w-lg">
        {error ? (
          <p role="alert" className="mb-2 rounded-xl bg-card p-3 text-sm text-destructive">
            {tBilling('orders.failed')}
          </p>
        ) : null}
        <PaymentSurface
          order={order}
          now={now}
          busy={busy}
          confirmClaim={confirmClaim}
          confirmCancel={confirmCancel}
          onAction={(action) => void act(action)}
          onClose={onClose}
        />
      </div>
    </Overlay>
  )
}
export function OrderHistory({
  onSelect,
  onClose,
}: {
  onSelect: (order: PurchaseOrder) => void
  onClose: () => void
}) {
  useTranslation()
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    void reloadKey
    let alive = true
    setError(false)
    setOrders(null)
    orderRequest<PurchaseOrder[]>()
      .then((rows) => {
        if (alive) setOrders(rows)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [reloadKey])
  return (
    <Dialog title={tBilling('orders.history')} onClose={onClose} className="max-w-xl">
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span>{tBilling('orders.failed')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            {tBilling('action.retry')}
          </Button>
        </div>
      ) : orders === null ? (
        <p className="py-8">{tBilling('pricing.loading')}</p>
      ) : orders.length === 0 ? (
        <p className="py-8 text-muted-foreground">{tBilling('orders.empty')}</p>
      ) : (
        orders.map((order) => (
          <Button
            key={order.id}
            type="button"
            onClick={() => onSelect(order)}
            variant="outline"
            className="mt-4 h-auto w-full justify-between whitespace-normal p-4 text-left"
          >
            <span>
              {order.kind === 'recharge' ? tBilling('action.recharge') : order.plan_name}
              <small className="mt-1 block font-mono text-label-sm text-muted-foreground">
                {order.code}
              </small>
            </span>
            <span>
              {formatMoney(order.amount_cents)}
              <small className="mt-1 block text-label-sm text-muted-foreground">
                {tBilling(`orders.status.${order.status}`)}
              </small>
            </span>
          </Button>
        ))
      )}
    </Dialog>
  )
}
