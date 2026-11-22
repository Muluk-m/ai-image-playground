import type { BillingPeriodMonths, PurchaseOrder } from '@image-playground/shared'
import { useRef, useState } from 'react'
import { Button, Icon } from '../../lib/privateHost'
import { formatMoney } from './billing-store'
import { type BillingKey, tBilling, useTranslation } from './i18n'
import { beginRecharge, beginRenewal, OrderRequestError, orderRequest } from './orders-client'

type Purchase = { planId: string; period: BillingPeriodMonths } | { amountCents: number }

function failureKey(error: unknown): BillingKey {
  if (error instanceof OrderRequestError) {
    switch (error.code) {
      case 'payments_unavailable':
        return 'recharge.unavailable'
      case 'open_order_exists':
        return 'orders.openOrderHint'
      case 'plan_unavailable':
      case 'price_unavailable':
        return 'orders.priceUnavailable'
      case 'scheduled_plan_change_exists':
        return 'orders.changeBlocked'
      case 'unauthorized':
        return 'orders.signInAgain'
    }
  }
  return 'orders.createFailed'
}

export function usePurchaseOrder() {
  const [order, setOrder] = useState<PurchaseOrder | null>(null)
  const [conflict, setConflict] = useState<PurchaseOrder | null>(null)
  const [error, setError] = useState<BillingKey | null>(null)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const request = useRef<{ key: string; id: string } | null>(null)
  const selected = useRef<Purchase | null>(null)
  const submit = async (input: Purchase) => {
    const key = JSON.stringify(input)
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const next =
      'planId' in input
        ? await beginRenewal(input.planId, input.period, request.current.id)
        : await beginRecharge(input.amountCents, request.current.id)
    setOrder(next)
    setConflict(null)
    request.current = null
  }
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (cause instanceof OrderRequestError && cause.code === 'open_order_exists' && cause.order) {
        setConflict(cause.order)
      } else {
        setError(failureKey(cause))
      }
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const buy = (input: Purchase) =>
    run(async () => {
      selected.current = input
      setConflict(null)
      await submit(input)
    })
  const replace = () =>
    run(async () => {
      if (!conflict || !selected.current) return
      // Cancel explicitly before buying; a lost response is safe to retry with the same request ID.
      let cancelled: PurchaseOrder
      try {
        cancelled = await orderRequest<PurchaseOrder>(`/${conflict.id}/cancel`, {})
      } catch (cause) {
        if (!(cause instanceof OrderRequestError) || cause.code !== 'order_not_payable') throw cause
        cancelled = await orderRequest<PurchaseOrder>(`/${conflict.id}`)
      }
      if (cancelled.status === 'review') {
        setConflict(cancelled)
        return
      }
      if (cancelled.status === 'completed') {
        setConflict(null)
        setOrder(cancelled)
        return
      }
      if (!['cancelled', 'expired', 'rejected'].includes(cancelled.status))
        throw new Error('cancel_unconfirmed')
      await submit(selected.current)
    })
  const resetFeedback = () => {
    setConflict(null)
    setError(null)
  }
  return { order, setOrder, conflict, error, busy, buy, replace, resetFeedback }
}

export function PurchaseFeedback({ purchase }: { purchase: ReturnType<typeof usePurchaseOrder> }) {
  useTranslation()
  const { conflict, error, busy } = purchase
  return (
    <>
      {error ? (
        <p role="alert" className="my-3 text-sm text-destructive">
          {tBilling(error)}
        </p>
      ) : null}
      {conflict ? (
        <div role="status" className="my-4 space-y-3 rounded-xl border border-border bg-muted p-4">
          <p className="text-sm font-medium">{tBilling('orders.openOrderTitle')}</p>
          <p className="text-sm">
            {conflict.kind === 'recharge' ? tBilling('action.recharge') : conflict.plan_name} ·{' '}
            {formatMoney(conflict.amount_cents)} · {tBilling(`orders.status.${conflict.status}`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {tBilling(
              conflict.status === 'review' ? 'orders.reviewOrderHint' : 'orders.replaceOrderHint',
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => purchase.setOrder(conflict)}
            >
              {tBilling('orders.viewExisting')}
            </Button>
            {conflict.status === 'pending' ? (
              <Button
                type="button"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void purchase.replace()}
              >
                {busy ? <Icon name="loading" className="animate-spin" /> : null}
                {tBilling(busy ? 'recharge.creating' : 'orders.replaceOrder')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}
