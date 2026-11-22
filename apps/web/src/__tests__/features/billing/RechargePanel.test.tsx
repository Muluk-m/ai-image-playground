// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import {
  beginRecharge,
  OrderRequestError,
  orderRequest,
} from '../../../features/billing/orders-client'

declare const vi: typeof import('vitest').vi

import { RechargePanel } from '../../../features/billing/PurchasePanels'

vi.mock('../../../features/billing/billing-store', async (original) => ({
  ...(await original<typeof import('../../../features/billing/billing-store')>()),
  useBilling: () => ({
    status: 'ready',
    catalog: {
      recharge_pricing: { credits_per_yuan: 400, amounts_yuan: [10, 50, 100] },
      settings: { payments_enabled: true },
    },
  }),
}))
vi.mock('../../../features/billing/orders-client', async (original) => ({
  ...(await original<typeof import('../../../features/billing/orders-client')>()),
  beginRecharge: vi.fn(),
  beginRenewal: vi.fn(),
  orderRequest: vi.fn(),
}))
vi.mock('../../../features/billing/PaymentPanel', () => ({
  PaymentPanel: () => <div>payment checkout</div>,
  OrderHistory: () => null,
}))
const host = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
async function mount() {
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<RechargePanel onClose={() => {}} />))
}
afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  vi.resetAllMocks()
})
it('quotes 20000 credits for 50 yuan and sends cents rather than client credit grants', async () => {
  vi.mocked(beginRecharge).mockResolvedValue({ id: 'order' } as Awaited<
    ReturnType<typeof beginRecharge>
  >)
  await mount()
  expect(document.body.textContent).toContain('¥1 = 400 积分')
  expect(document.body.textContent).toContain('到账 20,000 积分')
  const pay = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '去付款')!
  await act(async () => pay.click())
  expect(beginRecharge).toHaveBeenCalledWith(5000, expect.any(String))
  expect(document.body.textContent).toContain('payment checkout')
})
it('offers only the three approved recharge denominations', async () => {
  await mount()
  const amounts = [...document.body.querySelectorAll('button')]
    .map((b) => b.textContent)
    .filter((text) => text?.startsWith('¥'))
  expect(amounts).toEqual(['¥10', '¥50', '¥100'])
  expect(document.querySelector('input[name="recharge_amount"]')).toBeNull()
})

const membership = {
  id: 'old-membership',
  kind: 'subscription',
  plan_name: '入门',
  amount_cents: 3900,
  status: 'pending',
} as Awaited<ReturnType<typeof beginRecharge>>
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )!
  expect(button).toBeDefined()
  await act(async () => button.click())
}
it('keeps recharge visible and only cancels the old membership after an explicit action', async () => {
  vi.mocked(beginRecharge)
    .mockRejectedValueOnce(new OrderRequestError('open_order_exists', membership))
    .mockResolvedValueOnce({ id: 'recharge' } as typeof membership)
  vi.mocked(orderRequest).mockResolvedValue({ ...membership, status: 'cancelled' })
  await mount()
  await click('去付款')
  expect(document.body.textContent).not.toContain('payment checkout')
  expect(document.body.textContent).toContain('入门 · ¥39')
  expect(document.body.textContent).toContain('充值积分')
  expect(orderRequest).not.toHaveBeenCalled()
  await click('取消原订单并继续')
  expect(orderRequest).toHaveBeenCalledWith('/old-membership/cancel', {})
  expect(beginRecharge).toHaveBeenCalledTimes(2)
  expect(vi.mocked(beginRecharge).mock.calls[0]).toEqual(vi.mocked(beginRecharge).mock.calls[1])
  expect(document.body.textContent).toContain('payment checkout')
})
it('does not offer cancellation for an order awaiting payment review', async () => {
  vi.mocked(beginRecharge).mockRejectedValue(
    new OrderRequestError('open_order_exists', { ...membership, status: 'review' }),
  )
  await mount()
  await click('去付款')
  expect(document.body.textContent).toContain('正在核款')
  expect(document.body.textContent).not.toContain('取消原订单并继续')
  await click('查看原订单')
  expect(document.body.textContent).toContain('payment checkout')
  expect(orderRequest).not.toHaveBeenCalled()
})
it('keeps the request ID on an uncertain response and changes it with the recharge amount', async () => {
  vi.mocked(beginRecharge).mockRejectedValue(new TypeError('network unavailable'))
  await mount()
  await click('去付款')
  expect(document.body.textContent).toContain('订单暂未确认')
  await click('去付款')
  expect(vi.mocked(beginRecharge).mock.calls[0]).toEqual(vi.mocked(beginRecharge).mock.calls[1])
  await click('¥10')
  await click('去付款')
  expect(vi.mocked(beginRecharge).mock.calls[2][0]).toBe(1000)
  expect(vi.mocked(beginRecharge).mock.calls[2][1]).not.toBe(
    vi.mocked(beginRecharge).mock.calls[0][1],
  )
})
it('honors the new selection after an order conflict', async () => {
  vi.mocked(beginRecharge)
    .mockRejectedValueOnce(new OrderRequestError('open_order_exists', membership))
    .mockResolvedValueOnce({ id: 'ten-yuan' } as typeof membership)
  await mount()
  await click('去付款')
  await click('¥10')
  expect(document.body.textContent).not.toContain('取消原订单并继续')
  await click('去付款')
  expect(vi.mocked(beginRecharge).mock.calls[1][0]).toBe(1000)
  expect(orderRequest).not.toHaveBeenCalled()
})
it('refreshes a claimed order instead of cancelling or buying again', async () => {
  vi.mocked(beginRecharge).mockRejectedValue(new OrderRequestError('open_order_exists', membership))
  vi.mocked(orderRequest)
    .mockRejectedValueOnce(new OrderRequestError('order_not_payable'))
    .mockResolvedValueOnce({ ...membership, status: 'review' })
  await mount()
  await click('去付款')
  await click('取消原订单并继续')
  expect(beginRecharge).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('正在核款')
  expect(document.body.textContent).not.toContain('取消原订单并继续')
})
