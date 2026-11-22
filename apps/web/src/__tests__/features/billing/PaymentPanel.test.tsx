// @vitest-environment jsdom

import type { PurchaseOrder } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { PaymentSurface } from '../../../features/billing/PaymentPanel'

const order: PurchaseOrder = {
  id: 'order-fixture',
  code: 'ABC234',
  user_id: 'user',
  plan_id: 'standard',
  plan_name: '标准',
  period_months: 1,
  amount_cents: 7900,
  status: 'pending',
  created_at: 0,
  expires_at: Date.now() + 60000,
  claimed_at: null,
  completed_at: null,
  ends_at: null,
  review_note: '',
  payment_code: { id: 'qr1', channel: 'wechat', account: 'account', url: '/pay.png' },
  payment_history: [],
  payment_available: true,
  contact_qr_url: '/contact.png',
  contact_wechat: 'support',
  notification_status: 'pending',
}
function render(overrides: Partial<PurchaseOrder> = {}) {
  return renderToStaticMarkup(
    <PaymentSurface
      order={{ ...order, ...overrides }}
      busy={false}
      onAction={() => {}}
      onClose={() => {}}
      now={Date.now()}
    />,
  )
}
it('shows an exact whole-yuan amount and short remark with payment and support codes', () => {
  const html = render()
  expect(html).toContain('¥79')
  expect(html).not.toContain('79.00')
  expect(html).toContain('ABC234')
  expect(html).toContain('/pay.png')
  expect(html).toContain('/contact.png')
})
it('stops showing payment instructions and countdown while awaiting review', () => {
  const html = render({ status: 'review' })
  expect(html).not.toContain('/pay.png')
  expect(html).not.toContain('data-payment-countdown')
  expect(html).not.toContain('我已付款')
  expect(html).toContain('等待核款')
})
it('hides an unavailable or expired payment code', () => {
  expect(render({ payment_available: false })).not.toContain('/pay.png')
  expect(render({ expires_at: 0 })).not.toContain('/pay.png')
})

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
})
it('asks for the remark before submitting a payment claim and lets the user close', async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
  }
  const action = vi.fn(),
    close = vi.fn()
  await act(async () =>
    root!.render(
      <PaymentSurface
        order={order}
        busy={false}
        onAction={action}
        onClose={close}
        now={Date.now()}
      />,
    ),
  )
  await click('我已付款')
  expect(action).toHaveBeenCalledWith('claim')
  await act(async () =>
    root!.render(
      <PaymentSurface
        order={order}
        busy={false}
        onAction={action}
        onClose={close}
        now={Date.now()}
        confirmClaim
      />,
    ),
  )
  await click('确认已付款')
  expect(action).toHaveBeenCalledWith('confirm-claim')
  await click('关闭')
  expect(close).toHaveBeenCalledOnce()
})

it('tells a plan change it starts next cycle and keeps the current plan until then', () => {
  const html = render({ subscription_action: 'schedule', plan_name: '专业' })
  expect(html).toContain('专业 · 更换套餐')
  expect(html).toContain('当前套餐到期后生效（下一计费周期）')
  expect(html).not.toContain('暂未开放购买')
  const completed = render({
    subscription_action: 'schedule',
    status: 'completed',
    payment_available: false,
  })
  expect(completed).toContain('换档已预约，当前套餐到期后生效')
  expect(completed).toContain('当前周期的套餐与额度保持不变')
})

it('tells an upgrade it takes effect as soon as payment is confirmed', () => {
  const html = render({ subscription_action: 'upgrade', plan_name: '专业' })
  expect(html).toContain('专业 · 升级')
  expect(html).toContain('付款确认后立即生效，当前剩余额度并入新套餐')
  const completed = render({
    subscription_action: 'upgrade',
    status: 'completed',
    payment_available: false,
  })
  expect(completed).toContain('已升级，新套餐已生效，原剩余额度已并入')
})

it('shows locked recharge credits instead of a subscription period', () => {
  const html = render({
    kind: 'recharge',
    recharge_credits: 40000,
    plan_id: null,
    plan_name: null,
    period_months: null,
    amount_cents: 10000,
  })
  expect(html).toContain('充值积分')
  expect(html).toContain('40,000')
  expect(html).toContain('¥100')
  expect(html).not.toContain('个月')
  expect(html).not.toContain('续费')
})
