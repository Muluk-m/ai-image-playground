// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import { type AppLocale, i18next, setLocale } from '../../i18n'

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
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-expanded]')
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
    expect(localeRow().textContent).toContain('Interface language')
    expect(localeRow().textContent).toContain('English')
    expect(localeRow().getAttribute('aria-label')).toBe('Language: English. Switch to 中文')
  })

  it('英文下品牌只出现一次 Muvloom，中文下带拉丁字标', async () => {
    const brand = (): string => host.querySelector('h1')?.textContent ?? ''
    expect(brand()).toBe('幕芽Muvloom')

    await act(async () => {
      await setLocale('en')
    })

    expect(brand()).toBe('Muvloom')
  })
})
