// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GuestAccountMenu from '../../components/GuestAccountMenu'

const capabilities = vi.hoisted(() => ({ billing: false }))
vi.mock('../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: (key: string) => key === 'billing:credits' && capabilities.billing,
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(authEnabled: boolean): string {
  act(() =>
    root.render(
      <GuestAccountMenu
        authEnabled={authEnabled}
        onLogin={() => {}}
        onClose={() => {}}
        onOpenSettings={() => {}}
      />,
    ),
  )
  return host.textContent ?? ''
}

describe('访客菜单', () => {
  it('没有账号和计费的部署不提登录、同步和套餐', () => {
    capabilities.billing = false
    const text = render(false)
    expect(text).not.toContain('未登录')
    expect(text).not.toContain('登录后同步作品与积分')
    expect(text).not.toContain('套餐与定价')
    expect(text).toContain('帮助与指南')
  })

  it('收费部署照旧显示登录提示和套餐入口', () => {
    capabilities.billing = true
    const text = render(true)
    expect(text).toContain('未登录')
    expect(text).toContain('套餐与定价')
  })
})
