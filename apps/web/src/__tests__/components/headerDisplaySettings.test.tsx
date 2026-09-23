// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import { type AppLocale, i18next, setLocale } from '../../i18n'
import { setThemeChoice, THEME_STORAGE_KEY } from '../../theme'
import { pointer, stubPointerApis } from '../helpers/radix'

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
  stubPointerApis()
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
  await setLocale('zh-CN')
  localStorage.clear()
})

function openAccountMenu(): void {
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="打开个人账户"]')
  if (!trigger) throw new Error('missing account menu trigger')
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function displayTrigger(setting: 'locale' | 'theme'): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-display-setting="${setting}"]`)
  if (!element) throw new Error(`missing ${setting} control`)
  return element
}

/** 下拉的选项 portal 到 body 上，所以从 document 找，不从菜单里找。 */
function choose(setting: 'locale' | 'theme', optionText: string): void {
  act(() => {
    displayTrigger(setting).dispatchEvent(pointer('pointerdown'))
  })
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (node) => node.textContent?.trim() === optionText,
  )
  if (!option) throw new Error(`missing option ${optionText}`)
  act(() => {
    option.dispatchEvent(pointer('pointermove'))
    option.dispatchEvent(pointer('pointerup'))
  })
}

function whenLanguageChanged(target: AppLocale): Promise<void> {
  // tsconfig 的 lib 是 ES2020，没有 Promise.withResolvers。
  return new Promise((resolve) => {
    const onChanged = (language: string): void => {
      if (language !== target) return
      i18next.off('languageChanged', onChanged)
      resolve()
    }
    i18next.on('languageChanged', onChanged)
  })
}

describe('头像菜单里的显示设置', () => {
  it('平时不占顶栏，打开头像菜单才出现，并用语言自己的文字标出当前项', () => {
    expect(document.querySelector('[data-display-setting="locale"]')).toBeNull()

    openAccountMenu()

    expect(displayTrigger('locale').textContent).toContain('中文')
    expect(displayTrigger('theme').textContent).toContain('跟随系统')
  })

  it('选另一种语言写进本机，菜单留着让人看到变化', async () => {
    openAccountMenu()
    const changed = whenLanguageChanged('en')
    choose('locale', 'English')
    await act(async () => {
      await changed
    })

    expect(localStorage.getItem('aip.locale')).toBe('en')
    // 选项是 portal 出去的，宿主菜单的「点外面就关」必须放行，否则选择根本提交不了。
    expect(displayTrigger('locale').textContent).toContain('English')
  })
})

describe('头像菜单里的主题', () => {
  afterEach(() => {
    act(() => setThemeChoice('system'))
    document.documentElement.classList.remove('dark')
  })

  it('选一套就固定在本机，也能从这里选回跟随系统', () => {
    openAccountMenu()

    choose('theme', '暗色')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(displayTrigger('theme').textContent).toContain('暗色')

    choose('theme', '跟随系统')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })
})
