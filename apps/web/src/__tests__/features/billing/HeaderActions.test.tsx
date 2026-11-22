// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { HeaderActions } from '../../../features/billing/HeaderActions'

declare const vi: typeof import('vitest').vi

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
