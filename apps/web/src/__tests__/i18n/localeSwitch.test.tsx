// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen } from '../../auth/LoginScreen'
import { type AppLocale, i18next, setLocale } from '../../i18n'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function languageSelect(): HTMLSelectElement {
  const element = host.querySelector<HTMLSelectElement>('.auth-language select')
  if (!element) throw new Error('missing language select')
  return element
}

/** 切换是异步的（英文语料要先落地），等 i18next 自己宣布切完，别赌微任务轮数。 */
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

async function chooseLocale(value: AppLocale): Promise<void> {
  const changed = whenLanguageChanged(value)
  await act(async () => {
    const select = languageSelect()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await changed
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ providers: [] })),
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  localStorage.clear()
  await i18next.changeLanguage('zh-CN')
})

describe('locale switching', () => {
  it('renders Chinese by default and swaps the whole screen to English', async () => {
    await act(async () => {
      root.render(<LoginScreen />)
    })

    expect(host.textContent).toContain('欢迎回来')
    expect(host.textContent).toContain('登录即表示你同意我们的服务条款和隐私政策')

    await chooseLocale('en')

    expect(host.textContent).toContain('Welcome back')
    expect(host.textContent).toContain('By signing in you agree to our terms of service')
    expect(host.textContent).not.toContain('欢迎回来')
    expect(document.documentElement.lang).toBe('en')
    expect(languageSelect().value).toBe('en')
  })

  it('remembers the choice for the next visit', async () => {
    await act(async () => {
      root.render(<LoginScreen />)
    })
    await chooseLocale('en')

    expect(localStorage.getItem('aip.locale')).toBe('en')
  })

  it('keeps a server error readable after the language changes', async () => {
    window.history.replaceState(null, '', '/?auth_error=account_disabled')
    await act(async () => {
      root.render(<LoginScreen />)
    })

    expect(host.textContent).toContain('该账户已被停用')

    await chooseLocale('en')

    expect(host.textContent).toContain('This account has been disabled')
  })
})

describe('plural handling', () => {
  it('picks the English singular and plural forms by count', async () => {
    await act(async () => {
      await setLocale('en')
    })

    expect(i18next.t('download.succeeded', { ns: 'task', count: 1 })).toBe('Downloaded 1 image')
    expect(i18next.t('download.succeeded', { ns: 'task', count: 4 })).toBe('Downloaded 4 images')
  })

  it('uses the single Chinese form for any count', async () => {
    await act(async () => {
      await setLocale('zh-CN')
    })

    expect(i18next.t('download.succeeded', { ns: 'task', count: 1 })).toBe('成功下载 1 张图片')
    expect(i18next.t('download.succeeded', { ns: 'task', count: 4 })).toBe('成功下载 4 张图片')
  })
})
