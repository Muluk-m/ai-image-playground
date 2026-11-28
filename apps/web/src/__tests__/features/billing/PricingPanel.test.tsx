// @vitest-environment jsdom

import type { ScheduledPlanChange } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { beginRenewal } from '../../../features/billing/orders-client'
import { PricingPanel } from '../../../features/billing/PurchasePanels'
import { i18next } from '../../../lib/privateHost'

const { billing } = vi.hoisted(() => ({
  billing: {
    payments: true,
    subscription: null as null | {
      plan_id: string
      ends_at: number
      plan?: { id?: string; name: string; monthly_credits: number }
      scheduled_change?: ScheduledPlanChange | null
    },
  },
}))

vi.mock('../../../features/billing/billing-store', async (original) => ({
  ...(await original<typeof import('../../../features/billing/billing-store')>()),
  useBilling: () => ({
    status: 'ready',
    error: null,
    account: billing.subscription ? { subscription: billing.subscription } : { subscription: null },
    catalog: {
      model_prices: [],
      settings: { payments_enabled: billing.payments },
      plans: [
        plan('starter', '入门', 66_000, [
          [1, 4900, 3900],
          [3, 13500, 10500],
          [12, 46800, 34800],
        ]),
        plan('standard', '标准', 220_000, [
          [1, 9900, 7900],
          [3, 26700, 21300],
          [12, 94800, 70800],
        ]),
        plan('professional', '专业', 600_000, [
          [1, 19900, 15900],
          [3, 53700, 42900],
          [12, 190800, 142800],
        ]),
      ],
    },
  }),
}))
vi.mock('../../../features/billing/orders-client', async (original) => ({
  ...(await original<typeof import('../../../features/billing/orders-client')>()),
  beginRenewal: vi.fn(),
  beginRecharge: vi.fn(),
}))
vi.mock('../../../features/billing/PaymentPanel', () => ({
  PaymentPanel: () => <div>payment checkout</div>,
  OrderHistory: () => null,
}))

function plan(
  id: string,
  name: string,
  monthlyCredits: number,
  tiers: Array<[1 | 3 | 12, number, number]>,
) {
  return {
    id,
    name,
    monthly_credits: monthlyCredits,
    active: true,
    sort_order: monthlyCredits,
    max_concurrent_tasks: 1,
    updated_at: 0,
    prices: tiers.map(([period, original, effective]) => ({
      period_months: period,
      original_price_cents: original,
      discount_price_cents: effective < original ? effective : null,
      discount_ends_at: effective < original ? Date.now() + 86_400_000 : null,
      effective_price_cents: effective,
    })),
  }
}

function buttonFor(name: string) {
  const article = [...document.querySelectorAll('article')].find((node) =>
    node.querySelector('h3')?.textContent?.includes(name),
  )
  expect(article).toBeTruthy()
  const button = [...article!.querySelectorAll('button')].find((entry) =>
    ['开通会员', '续费', '升级', '更换套餐', '待生效'].includes(entry.textContent?.trim() ?? ''),
  )
  expect(button).toBeTruthy()
  return button!
}

let root: Root | undefined
const host = document.createElement('div')
afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  billing.payments = true
  billing.subscription = null
  vi.resetAllMocks()
})

async function mount() {
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<PricingPanel onClose={() => {}} />))
}

it('lets a user without a plan buy any priced tier', async () => {
  vi.mocked(beginRenewal).mockResolvedValue({ id: 'order' } as Awaited<
    ReturnType<typeof beginRenewal>
  >)
  await mount()
  expect(document.body.textContent).not.toContain('暂未开放购买')
  for (const name of ['入门', '标准', '专业']) {
    const button = buttonFor(name)
    expect(button.textContent).toBe('开通会员')
    expect(button.disabled).toBe(false)
  }
  await act(async () => buttonFor('标准').click())
  expect(beginRenewal).toHaveBeenCalledWith('standard', 1, expect.any(String))
  expect(document.body.textContent).toContain('payment checkout')
})

it('keeps renewal on the current plan id, upgrades higher tiers now and schedules lower ones', async () => {
  billing.subscription = {
    plan_id: 'starter-old',
    ends_at: Date.now() + 86_400_000,
    plan: { id: 'standard', name: '标准', monthly_credits: 220_000 },
    scheduled_change: null,
  }
  await mount()
  expect(buttonFor('标准').textContent).toBe('续费')
  expect(buttonFor('标准').disabled).toBe(false)
  expect(buttonFor('入门').textContent).toBe('更换套餐')
  expect(buttonFor('专业').textContent).toBe('升级')
  expect(document.body.textContent).toContain('当前套餐到期后生效（下一计费周期）')
  expect(document.body.textContent).toContain('付款确认后立即生效，当前剩余额度并入新套餐')
  expect(document.body.textContent).not.toContain('暂未开放购买')
})

it('falls back to plan_id when the plan summary has no id', async () => {
  billing.subscription = {
    plan_id: 'starter',
    ends_at: Date.now() + 86_400_000,
    plan: { name: '入门', monthly_credits: 66_000 },
  }
  await mount()
  expect(buttonFor('入门').textContent).toBe('续费')
  expect(buttonFor('标准').textContent).toBe('升级')
})

it('shows the old plan until a scheduled change takes effect', async () => {
  billing.subscription = {
    plan_id: 'starter',
    ends_at: Date.now() + 86_400_000,
    plan: { id: 'starter', name: '入门', monthly_credits: 66_000 },
    scheduled_change: {
      plan_id: 'professional',
      plan_name: '专业',
      period_months: 1,
      effective_at: Date.now() + 86_400_000,
    },
  }
  await mount()
  expect(buttonFor('入门').textContent).toBe('续费')
  expect(document.body.textContent).toContain('当前套餐')
  expect(buttonFor('专业').textContent).toBe('待生效')
  expect(buttonFor('专业').disabled).toBe(true)
  expect(buttonFor('标准').disabled).toBe(true)
  expect(document.body.textContent).toContain('已预约更换为 专业，当前套餐到期后生效')
  expect(document.body.textContent).toContain('当前周期仍使用现有套餐与额度')
})

it('disables purchase while payments are off without calling the tier unavailable', async () => {
  billing.payments = false
  await mount()
  expect(buttonFor('入门').disabled).toBe(true)
  expect(buttonFor('入门').textContent).toBe('开通会员')
  expect(document.body.textContent).not.toContain('暂未开放购买')
  // 原因只在悬停置灰按钮时说明（BUG-60），不加可见的说明行。
  expect(buttonFor('入门').getAttribute('aria-description')).toBe('暂未开放购买')
})

it('does not describe a purchasable plan button as unavailable', async () => {
  await mount()
  expect(buttonFor('入门').getAttribute('aria-description')).toBeNull()
})

it('shows immediate progress and prevents duplicate clicks while creating a membership order', async () => {
  vi.mocked(beginRenewal).mockReturnValue(new Promise(() => {}))
  await mount()
  const button = buttonFor('入门')
  await act(async () => button.click())
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.textContent).toContain('正在创建订单')
  expect(button.querySelector('.animate-spin')).not.toBeNull()
  await act(async () => button.click())
  expect(beginRenewal).toHaveBeenCalledTimes(1)
})

it('uses a new request ID when a failed membership purchase changes plans', async () => {
  vi.mocked(beginRenewal).mockRejectedValue(new TypeError('network unavailable'))
  await mount()
  await act(async () => buttonFor('入门').click())
  await act(async () => buttonFor('入门').click())
  expect(vi.mocked(beginRenewal).mock.calls[0]).toEqual(vi.mocked(beginRenewal).mock.calls[1])
  await act(async () => buttonFor('标准').click())
  expect(vi.mocked(beginRenewal).mock.calls[2][2]).not.toBe(
    vi.mocked(beginRenewal).mock.calls[0][2],
  )
})

it('shows the localized plan names in English, including the scheduled change line (BUG-65)', async () => {
  await i18next.changeLanguage('en')
  try {
    billing.subscription = {
      plan_id: 'starter',
      ends_at: Date.now() + 86_400_000,
      plan: { id: 'starter', name: '入门', monthly_credits: 66_000 },
      scheduled_change: {
        plan_id: 'professional',
        plan_name: '专业',
        period_months: 1,
        effective_at: Date.now() + 86_400_000,
      },
    }
    await mount()
    const titles = [...document.querySelectorAll('article h3')].map((node) => node.textContent)
    expect(titles).toEqual(['Starter', 'Standard', 'Professional'])
    expect(document.body.textContent).not.toMatch(/入门|标准|专业/)
    expect(document.body.textContent).toContain(
      'Switching to Professional after the current plan ends',
    )
    expect(document.body.textContent).toContain('20% off')
    expect(document.body.textContent).toContain('Most popular')
    expect(document.body.textContent).toContain('Save ¥10')
  } finally {
    await i18next.changeLanguage('zh-CN')
  }
})

it('shows cycle tab discount badges, tier highlights, savings, and switches to yearly on nudge click', async () => {
  await mount()
  const initialText = document.body.textContent ?? ''
  expect(initialText).toContain('省 29%')
  expect(initialText).toContain('省 41%')
  expect(initialText).toContain('最受欢迎')
  expect(initialText).toContain('性价比之选')
  expect(initialText).toContain('限时 8 折')
  expect(initialText).toContain('立省 ¥10')
  expect(initialText).toContain('立省 ¥20')
  expect(initialText).toContain('立省 ¥40')

  const nudge = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('切至年付，一年立省 ¥480'),
  )
  expect(nudge).toBeTruthy()
  await act(async () => nudge!.click())

  const yearlyText = document.body.textContent ?? ''
  expect(yearlyText).toContain('限时 5.9 折 · 省 41%')
  expect(yearlyText).toContain('限时 6 折 · 省 40%')
  expect(yearlyText).toContain('12 个月共 ¥348')
  expect(yearlyText).toContain('立省 ¥240')
  expect(yearlyText).toContain('立省 ¥480')
  expect(yearlyText).toContain('立省 ¥960')
  expect(yearlyText).not.toContain('切至年付')
})
