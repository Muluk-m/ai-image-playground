// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginDialog } from '../../auth/LoginDialog'
import DisplaySettingsMenuItems from '../../components/DisplaySettingsMenuItems'
import { type AppLocale, i18next, setLocale } from '../../i18n'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { pointer, stubPointerApis } from '../helpers/radix'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

/**
 * 语言下拉在头像菜单里（登录框自己不带显示设置）。这里直接渲染那两行，
 */
function localeTrigger(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-display-setting="locale"]')
  if (!element) throw new Error('missing locale control')
  return element
}

function dialogText(): string {
  return document.body.querySelector('.auth-dialog')?.textContent ?? ''
}

/** 切换是异步的（英文语料要先落地），等 i18next 自己宣布切完，别赌微任务轮数。 */
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

/** 选项 portal 到 body 上，所以从 document 找。 */
async function chooseLocale(value: AppLocale): Promise<void> {
  const changed = whenLanguageChanged(value)
  act(() => {
    localeTrigger().dispatchEvent(pointer('pointerdown'))
  })
  const option = document.querySelector(`[role="option"][data-locale="${value}"]`)
  if (!option) throw new Error(`missing option ${value}`)
  act(() => {
    option.dispatchEvent(pointer('pointermove'))
    option.dispatchEvent(pointer('pointerup'))
  })
  await act(async () => {
    await changed
  })
}

async function renderLoginSurface(): Promise<void> {
  await act(async () => {
    root.render(
      <>
        <DisplaySettingsMenuItems itemClassName="" iconClassName="" />
        <LoginDialog onClose={() => {}} />
      </>,
    )
  })
}

beforeEach(() => {
  stubPointerApis()
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
    await renderLoginSurface()

    expect(dialogText()).toContain('欢迎回来')
    expect(dialogText()).toContain('登录即表示你同意我们的服务条款和隐私政策')

    await chooseLocale('en')

    expect(dialogText()).toContain('Welcome back')
    expect(dialogText()).toContain('By signing in you agree to our terms of service')
    expect(dialogText()).not.toContain('欢迎回来')
    expect(document.documentElement.lang).toBe('en')
    expect(localeTrigger().textContent).toContain('English')
  })

  it('remembers the choice for the next visit', async () => {
    await renderLoginSurface()
    await chooseLocale('en')

    expect(localStorage.getItem('aip.locale')).toBe('en')
  })

  it('keeps a server error readable after the language changes', async () => {
    window.history.replaceState(null, '', '/?auth_error=account_disabled')
    await renderLoginSurface()

    expect(dialogText()).toContain('该账户已被停用')

    await chooseLocale('en')

    expect(dialogText()).toContain('This account has been disabled')
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
