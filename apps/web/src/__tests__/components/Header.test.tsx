// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import DataTab from '../../components/settings/DataTab'
import { useStore } from '../../store'

// 私有 overlay 接管账号区（replacesAuthActions）后公开的退出按钮不再渲染；这里测的是公开分支。
vi.mock('../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/privateOverlay')>()),
  PrivateWebHeaderCreditAction: () => <button aria-label="积分余额">—</button>,
  PrivateWebHeaderAccountActions: () => <button aria-label="收费版账户头像">头像</button>,
  PrivateWebReplacesAuthActions: false,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({ appMode: 'image' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function renderLoggedIn(
  logout: (clearLocalData: boolean) => Promise<void>,
  children: ReactNode = <Header />,
): void {
  act(() =>
    root.render(
      <AuthContextProvider
        value={{
          enabled: true,
          user: { id: 'u1', username: '小马' },
          login: () => {},
          logout,
        }}
      >
        {children}
      </AuthContextProvider>,
    ),
  )
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find((it) => it.textContent === label)
  if (!button) throw new Error(`no button labelled ${label}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('the header', () => {
  it('does not auto-open onboarding prompts for a fresh empty account', () => {
    useStore.setState({ inspirationCoachDismissed: false, tasks: [] })
    act(() => root.render(<Header />))
    expect(document.body.textContent).not.toContain('不知道画什么')
    expect(document.querySelector('.animate-coach-pulse')).toBeNull()
    // 灵感搬进「库」的页签后，顶栏不再有它自己的图标。
    expect(document.querySelector('button[aria-label="灵感库"]')).toBeNull()
  })

  it('未登录时有登录入口和应用菜单（切主题与语言），登录后换成积分和账户入口', () => {
    const login = vi.fn()
    const logout = vi.fn(async () => {})
    const render = (user: { id: string; username: string } | null) =>
      root.render(
        <AuthContextProvider value={{ enabled: true, user, login, logout }}>
          <Header />
        </AuthContextProvider>,
      )

    act(() => render(null))
    expect(host.querySelector('[aria-label="积分余额"]')).toBeNull()
    expect(host.querySelector('[aria-label="收费版账户头像"]')).toBeNull()
    expect(host.querySelector('img[src="/brand/avatar-artist-192.png"]')).toBeNull()
    expect(host.querySelector('[aria-label="打开应用菜单"]')).not.toBeNull()
    click('登录')
    expect(login).toHaveBeenCalledOnce()

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="打开应用菜单"]')?.click()
    })
    expect(document.body.textContent).toContain('未登录')
    expect(document.body.textContent).toContain('免费体验')
    expect(document.body.textContent).toContain('帮助与指南')
    expect(document.body.textContent).not.toContain('帮助中心')
    expect(document.body.textContent).not.toContain('使用指南')
    expect(document.body.textContent).not.toContain('界面语言')
    expect(document.body.textContent).toContain('主题')
    expect(document.body.textContent).toContain('设置')
    expect(document.body.textContent).toContain('服务条款')
    click('登录 / 注册')
    expect(login).toHaveBeenCalledTimes(2)

    act(() => render({ id: 'u1', username: '小马' }))
    expect(host.querySelector('[aria-label="积分余额"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="收费版账户头像"]')).not.toBeNull()
    expect(host.querySelector('img[src="/brand/avatar-artist-192.png"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="打开个人账户"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('未登录')
    expect(host.querySelector('button')?.textContent).not.toBe('登录')
  })

  it('顶栏没有横栏了：账号这一簇浮在右上角，不带品牌与导航', () => {
    act(() => root.render(<Header />))

    expect(document.querySelector('header')).toBeNull()
    expect(document.querySelector('[aria-label="幕芽 Muvloom，回到画布"]')).toBeNull()
    // 入口全在侧栏，浮层里不再重复一套。
    expect([...document.querySelectorAll('button')].some((one) => one.textContent === '资产')).toBe(
      false,
    )
  })

  it('滚离页顶后右上角账号簇带上磨砂底，回到顶部则去掉', () => {
    act(() => root.render(<Header />))
    const float = host.querySelector('.studio-header-float')
    expect(float?.hasAttribute('data-scrolled')).toBe(false)

    const scrollY = vi.spyOn(window, 'scrollY', 'get')
    scrollY.mockReturnValue(24)
    act(() => {
      document.dispatchEvent(new Event('scroll'))
    })
    expect(float?.hasAttribute('data-scrolled')).toBe(true)

    scrollY.mockReturnValue(0)
    act(() => {
      document.dispatchEvent(new Event('scroll'))
    })
    expect(float?.hasAttribute('data-scrolled')).toBe(false)
    scrollY.mockRestore()
  })

  it('语言和访客菜单是 40px 图标，画布窄屏也留着深色顶栏', () => {
    act(() => root.render(<Header />))
    expect(host.querySelector('[aria-label="界面语言"]')?.className).toContain('size-10')
    expect(host.querySelector('[aria-label="打开应用菜单"]')?.className).toContain('size-10')
    expect(host.querySelector('.studio-mobile-topbar')).not.toBeNull()

    act(() => useStore.setState({ appMode: 'canvas' }))
    expect(host.querySelector('.studio-mobile-topbar')).not.toBeNull()
    expect(document.querySelector('header')).toBeNull()
  })
})

describe('logging out', () => {
  it('signs out from the account menu immediately and keeps local data', () => {
    const logout = vi.fn(async () => {})
    renderLoggedIn(logout)

    act(() => {
      host.querySelector<HTMLButtonElement>('button[aria-label="打开个人账户"]')?.click()
    })
    click('退出登录')

    expect(logout).toHaveBeenCalledExactlyOnceWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('同时清除这个浏览器里的数据')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('signs out from settings immediately and disables repeated clicks', () => {
    const logout = vi.fn(async () => {})
    renderLoggedIn(logout, <DataTab />)
    click('退出登录')

    expect(logout).toHaveBeenCalledExactlyOnceWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('同时清除这个浏览器里的数据')
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent === '退出中',
    )
    expect(button?.disabled).toBe(true)
    act(() => button?.click())
    expect(logout).toHaveBeenCalledOnce()
  })
})
