// @vitest-environment jsdom
import type { UserAccountSnapshot } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountPanel } from '../../../features/billing/AccountPanel'
import type { BillingSnapshot } from '../../../features/billing/billing-store'
import { HeaderActions, HeaderCreditAction } from '../../../features/billing/HeaderActions'
import { i18next } from '../../../lib/privateHost'
import { bootstrapCapabilities } from './capabilities'

let mockBilling: BillingSnapshot = {
  status: 'ready',
  error: null,
  account: null,
  catalog: null,
}

vi.mock('../../../features/billing/billing-store', async (original) => ({
  ...(await original<typeof import('../../../features/billing/billing-store')>()),
  useBilling: () => mockBilling,
}))
vi.mock('../../../features/billing/profile-store', async (original) => ({
  ...(await original<typeof import('../../../features/billing/profile-store')>()),
  useAccountProfile: () => ({ profile: null }),
  loadAccountProfile: async () => {},
  clearAccountProfile: () => {},
}))
vi.mock('../../../features/billing/AccountSettings', () => ({
  AccountSettings: ({ username }: { username: string | null }) => (
    <div data-testid="account-settings-stub">{username}</div>
  ),
}))
vi.mock('../../../features/billing/ActivityHeatGraph', () => ({
  ActivitySection: () => null,
}))

const DAY_MS = 24 * 60 * 60 * 1000
const host = document.createElement('div')
let root: Root | undefined

function makeAccount({
  subscriptionBalance,
  rechargeBalance = 0,
  subscriptionExpiresAt,
  planEndsAt,
}: {
  subscriptionBalance: number
  rechargeBalance?: number
  subscriptionExpiresAt: number | null
  planEndsAt?: number | null
}): UserAccountSnapshot {
  return {
    account: {
      subscription_balance: subscriptionBalance,
      recharge_balance: rechargeBalance,
      subscription_expires_at: subscriptionExpiresAt,
    },
    subscription:
      planEndsAt != null
        ? {
            id: 'sub-1',
            status: 'active',
            plan_id: 'standard',
            period_months: 1,
            starts_at: planEndsAt - 30 * DAY_MS,
            ends_at: planEndsAt,
            next_grant_at: null,
            plan: { id: 'standard', name: '标准', monthly_credits: 1_000 },
          }
        : null,
    ledger: [],
    model_prices: [],
    catalog: { plans: [], settings: null, model_prices: [] },
  }
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': false })
  mockBilling = { status: 'ready', error: null, account: null, catalog: null }
})

afterEach(async () => {
  act(() => root?.unmount())
  host.remove()
  document.body.innerHTML = ''
  await i18next.changeLanguage('zh-CN')
})

it('登录后的账户菜单有「联系我们」，打开只给邮箱的联系弹窗', async () => {
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <HeaderActions
        username="qa@example.com"
        loggingOut={false}
        syncPending={false}
        onOpenSettings={() => {}}
        onLogout={() => {}}
      />,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  await act(async () => trigger.click())
  const contact = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.includes('联系我们'),
  )
  expect(contact).toBeDefined()
  await act(async () => contact!.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  const hrefs = [...document.querySelectorAll('[role="dialog"] a')].map((a) =>
    a.getAttribute('href'),
  )
  expect(hrefs).toHaveLength(1)
  expect(hrefs[0]).toMatch(/^mailto:[^@\s]+@[^@\s]+$/)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(hrefs[0]!.slice(7))
})

it('计费关闭时已登录用户仍保留「账户设置」入口，且打开后不暴露计费标签与套餐文案', async () => {
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <HeaderActions
        username="selfhosted@example.com"
        loggingOut={false}
        syncPending={false}
        onOpenSettings={() => {}}
        onLogout={() => {}}
      />,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  await act(async () => trigger.click())
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const settings = items.find((item) => item.textContent?.includes('账户设置'))
  expect(settings).toBeDefined()
  expect(items.some((item) => item.textContent?.includes('积分明细'))).toBe(false)
  expect(items.some((item) => item.textContent?.includes('邀请奖励'))).toBe(false)

  await act(async () => settings!.click())
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog?.querySelector('[data-testid="account-settings-stub"]')?.textContent).toBe(
    'selfhosted@example.com',
  )
  expect(dialog?.textContent).not.toContain('未开通会员')
  expect(dialog?.textContent).not.toContain('积分明细')
  expect(dialog?.textContent).not.toContain('邀请奖励')
  expect(dialog?.textContent).not.toContain('开通套餐')
  expect(dialog?.textContent).not.toContain('充值积分')
})

it('顶栏积分按钮在大于 7 天时展示到期日期，进入 7 天倒计时时切换为 warning 提醒态', async () => {
  await bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': true })
  const farExpiry = Date.now() + 20 * DAY_MS
  mockBilling = {
    status: 'ready',
    error: null,
    account: makeAccount({
      subscriptionBalance: 800,
      rechargeBalance: 200,
      subscriptionExpiresAt: farExpiry,
      planEndsAt: farExpiry,
    }),
    catalog: null,
  }
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<HeaderCreditAction />))

  const normalBtn = host.querySelector('button')!
  expect(normalBtn.textContent).toContain('1,000')
  expect(normalBtn.textContent).toContain('到期')
  expect(normalBtn.className).not.toContain('border-warning')
  expect(normalBtn.getAttribute('aria-label')).toContain('800 套餐积分将于')

  // 进入 7 天倒计时：按钮边框与倒计时徽标切换到 warning 语义色。
  const soonExpiry = Date.now() + 5 * DAY_MS - 1_000
  mockBilling = {
    ...mockBilling,
    account: makeAccount({
      subscriptionBalance: 800,
      rechargeBalance: 200,
      subscriptionExpiresAt: soonExpiry,
      planEndsAt: soonExpiry,
    }),
  }
  await act(async () => root!.render(<HeaderCreditAction />))

  const warnBtn = host.querySelector('button')!
  expect(warnBtn.textContent).toContain('1,000')
  expect(warnBtn.textContent).toContain('剩 5 天')
  expect(warnBtn.className).toContain('border-warning/60')
  expect(warnBtn.innerHTML).toContain('text-warning')

  // 切换到英文后同步更新文案。
  await act(async () => {
    await i18next.changeLanguage('en')
  })
  expect(warnBtn.textContent).toContain('5d left')
})

it('仅持有充值积分时顶栏不展示到期提醒', async () => {
  await bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': true })
  mockBilling = {
    status: 'ready',
    error: null,
    account: makeAccount({
      subscriptionBalance: 0,
      rechargeBalance: 500,
      subscriptionExpiresAt: null,
      planEndsAt: null,
    }),
    catalog: null,
  }
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<HeaderCreditAction />))

  const btn = host.querySelector('button')!
  expect(btn.textContent).toContain('500')
  expect(btn.textContent).not.toContain('到期')
  expect(btn.textContent).not.toContain('剩')
  expect(btn.className).not.toContain('border-warning')
})

it('头像下拉菜单与账户概览在 7 天内展示 warning 清零提醒，套餐积分为 0 时不误报', async () => {
  await bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': true })
  const soonExpiry = Date.now() + 3 * DAY_MS - 1_000
  mockBilling = {
    status: 'ready',
    error: null,
    account: makeAccount({
      subscriptionBalance: 600,
      rechargeBalance: 100,
      subscriptionExpiresAt: soonExpiry,
      planEndsAt: soonExpiry + 60 * DAY_MS,
    }),
    catalog: null,
  }
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <HeaderActions
        username="qa@example.com"
        loggingOut={false}
        syncPending={false}
        onOpenSettings={() => {}}
        onLogout={() => {}}
      />,
    ),
  )

  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  // 移动端头像角标提示
  expect(trigger.querySelector('.bg-warning')).not.toBeNull()

  await act(async () => trigger.click())
  const statusBanner = host.querySelector('[role="status"]')
  expect(statusBanner).not.toBeNull()
  expect(statusBanner?.textContent).toContain('剩 3 天')
  expect(statusBanner?.textContent).toContain('600 套餐积分将于')
  expect(statusBanner?.className).toContain('text-warning')

  // 账户概览中的套餐积分卡高亮提醒
  await act(async () =>
    root!.render(
      <AccountPanel
        username="qa@example.com"
        initialView="overview"
        onClose={() => {}}
        onOpenPricing={() => {}}
        onOpenRecharge={() => {}}
        onAccountDeleted={() => {}}
      />,
    ),
  )
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('剩 3 天')
  expect(dialog.textContent).toContain('到期清零')
  expect(dialog.innerHTML).toContain('border-warning/50')

  // 套餐积分已用完（0）时，套餐积分卡不显示 warning 高亮
  mockBilling = {
    ...mockBilling,
    account: makeAccount({
      subscriptionBalance: 0,
      rechargeBalance: 100,
      subscriptionExpiresAt: soonExpiry,
      planEndsAt: soonExpiry + 60 * DAY_MS,
    }),
  }
  await act(async () =>
    root!.render(
      <AccountPanel
        username="qa@example.com"
        initialView="overview"
        onClose={() => {}}
        onOpenPricing={() => {}}
        onOpenRecharge={() => {}}
        onAccountDeleted={() => {}}
      />,
    ),
  )
  const dialogAfterZero = document.querySelector('[role="dialog"]')!
  expect(dialogAfterZero.innerHTML).not.toContain('border-warning/50')
})
