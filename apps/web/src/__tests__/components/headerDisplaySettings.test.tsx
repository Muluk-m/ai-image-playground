// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import { type AppLocale, i18next, setLocale } from '../../i18n'
import { setThemeChoice } from '../../theme'

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
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <AuthContextProvider
        value={{ enabled: true, user: { id: 'u1', username: '小马' }, logout: async () => {} }}
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
  await setLocale('zh-CN')
  localStorage.clear()
})

function openAccountMenu(): void {
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="打开个人账户"]')
  if (!trigger) throw new Error('missing account menu trigger')
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function localeRow(): HTMLButtonElement {
  const row = host.querySelector<HTMLButtonElement>('[data-display-setting="locale"]')
  if (!row) throw new Error('missing locale row')
  return row
}

function whenLanguageChanged(target: AppLocale): Promise<void> {
  return new Promise((resolve) => {
    const onChanged = (language: string): void => {
      if (language !== target) return
      i18next.off('languageChanged', onChanged)
      resolve()
    }
    i18next.on('languageChanged', onChanged)
  })
}

describe('头像菜单里的界面语言', () => {
  it('平时不占顶栏，打开头像菜单才出现，并用语言自己的文字标出当前项', () => {
    expect(host.querySelector('[data-display-setting="locale"]')).toBeNull()

    openAccountMenu()

    expect(localeRow().textContent).toContain('界面语言')
    expect(localeRow().textContent).toContain('中文')
    expect(localeRow().getAttribute('aria-label')).toBe('界面语言：中文，点击切换到 English')
  })

  it('点一下切到另一种语言，写进本机，菜单留着让人看到变化', async () => {
    openAccountMenu()
    const changed = whenLanguageChanged('en')
    await act(async () => {
      localeRow().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await changed
    })

    expect(localStorage.getItem('aip.locale')).toBe('en')
    expect(localeRow().textContent).toContain('Language')
    expect(localeRow().textContent).toContain('English')
    expect(localeRow().getAttribute('aria-label')).toBe('Language: English. Switch to 中文')
  })
})

describe('头像菜单里的主题', () => {
  function themeRow(): HTMLButtonElement {
    const row = host.querySelector<HTMLButtonElement>('[data-display-setting="theme"]')
    if (!row) throw new Error('missing theme row')
    return row
  }

  afterEach(() => {
    act(() => setThemeChoice('system'))
    document.documentElement.classList.remove('dark')
  })

  it('标出当前生效的一套，点一下翻到另一套并固定在本机', () => {
    openAccountMenu()
    expect(themeRow().textContent).toContain('主题')
    expect(themeRow().textContent).toContain('亮色')
    expect(themeRow().getAttribute('aria-label')).toBe('切到暗色')

    act(() => themeRow().dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('aip.theme')).toBe('dark')
    expect(themeRow().textContent).toContain('暗色')
    expect(themeRow().getAttribute('aria-label')).toBe('切到亮色')
  })
})
