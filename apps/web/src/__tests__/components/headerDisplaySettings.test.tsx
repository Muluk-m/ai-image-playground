// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import { initTheme, THEME_STORAGE_KEY } from '../../theme'

// 测的是公开树自己的头像菜单；私有 overlay 接管账号区时渲染的是同一个 DisplaySettingsMenuItems。
vi.mock('../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/privateOverlay')>()),
  PrivateWebHeaderCreditAction: () => null,
  PrivateWebHeaderAccountActions: () => null,
  PrivateWebReplacesAuthActions: false,
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  initTheme()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <AuthContextProvider
        value={{
          enabled: true,
          user: { id: 'u1', username: '小马' },
          login: () => {},
          logout: async () => {},
        }}
      >
        <Header />
      </AuthContextProvider>,
    ),
  )
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

function openAccountMenu(): void {
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="打开个人账户"]')
  if (!trigger) throw new Error('missing account menu trigger')
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function pressTheme(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (node) =>
      node.getAttribute('aria-label') === label && node.getAttribute('aria-pressed') != null,
  )
  if (!button) throw new Error(`missing theme ${label}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('头像菜单里的显示设置', () => {
  it('不放语言行；语言只在顶栏地球，主题是三段图标开关', () => {
    expect(document.querySelector('[data-display-setting="locale"]')).toBeNull()
    expect(host.querySelector('button[aria-label="界面语言"]')).not.toBeNull()

    openAccountMenu()

    expect(document.querySelector('[data-display-setting="locale"]')).toBeNull()
    expect(document.body.textContent).not.toContain('界面语言')
    expect(document.body.textContent).toContain('主题')
    expect(pressThemeLabel('暗色')?.getAttribute('aria-pressed')).toBe('true')
    expect(pressThemeLabel('跟随系统')?.getAttribute('aria-pressed')).toBe('false')
    expect(pressThemeLabel('亮色')?.getAttribute('aria-pressed')).toBe('false')
  })
})

function pressThemeLabel(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (node) =>
      node.getAttribute('aria-label') === label && node.getAttribute('aria-pressed') != null,
  )
}

describe('头像菜单里的主题', () => {
  it('可以在暗色、跟随系统和亮色之间切换，选择记在本机', () => {
    vi.stubGlobal('matchMedia', (query: string) => {
      expect(query).toBe('(prefers-color-scheme: dark)')
      return {
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }
    })
    openAccountMenu()

    pressTheme('亮色')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(pressThemeLabel('亮色')?.getAttribute('aria-pressed')).toBe('true')

    pressTheme('暗色')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(pressThemeLabel('暗色')?.getAttribute('aria-pressed')).toBe('true')

    pressTheme('跟随系统')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(pressThemeLabel('跟随系统')?.getAttribute('aria-pressed')).toBe('true')
  })
})
