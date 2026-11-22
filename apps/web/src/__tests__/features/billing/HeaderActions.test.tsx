// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { HeaderActions } from '../../../features/billing/HeaderActions'

vi.mock('../../../features/billing/billing-store', async (original) => ({
  ...(await original<typeof import('../../../features/billing/billing-store')>()),
  useBilling: () => ({ status: 'ready', error: null, account: null, catalog: null }),
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

const host = document.createElement('div')
let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
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
