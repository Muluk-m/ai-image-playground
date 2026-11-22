import type { BillingPeriodMonths, PurchaseOrder } from '@image-playground/shared'
import { authenticatedBffFetch, getRuntimeConfig } from '../../lib/privateHost'
export class OrderRequestError extends Error {
  constructor(
    readonly code: string,
    readonly order?: PurchaseOrder,
  ) {
    super(code)
  }
}

export async function orderRequest<T>(path = '', body?: unknown): Promise<T> {
  const response = await authenticatedBffFetch(
    `${getRuntimeConfig().bff.baseUrl.replace(/\/+$/, '')}/api/billing/orders${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
  const result = await response.json()
  if (!response.ok) throw new OrderRequestError(result.error ?? 'order_failed', result.order)
  return result as T
}
export async function beginRenewal(planId: string, period: BillingPeriodMonths, requestId: string) {
  return orderRequest<PurchaseOrder>('', {
    plan_id: planId,
    period_months: period,
    request_id: requestId,
  })
}

export async function beginRecharge(amountCents: number, requestId: string) {
  return orderRequest<PurchaseOrder>('', {
    kind: 'recharge',
    amount_cents: amountCents,
    request_id: requestId,
  })
}
