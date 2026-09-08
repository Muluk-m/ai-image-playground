// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import Header from '../../components/Header'
import { useStore } from '../../store'

// 私有 overlay 接管账号区（replacesAuthActions）后公开的退出按钮不再渲染；这里测的是公开分支。
vi.mock('../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/privateOverlay')>()),
  PrivateWebHeaderCreditAction: () => null,
  PrivateWebHeaderAccountActions: () => null,
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
  useStore.setState({ appMode: 'browse' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function renderLoggedIn(logout: (clearLocalData: boolean) => Promise<void>): void {
  act(() =>
    root.render(
      <AuthContextProvider
        value={{
          enabled: true,
          user: { id: 'u1', username: '小马' },
          logout,
        }}
      >
        <Header />
      </AuthContextProvider>,
    ),
  )
}

/** 浮层 portal 到 body，落在 host 之外，所以退出按钮在两处同名时靠这个分开。 */
function click(label: string, where: 'header' | 'dialog' = 'header'): void {
  const buttons = [...document.querySelectorAll('button')].filter(
    (it) => it.textContent === label && host.contains(it) === (where === 'header'),
  )
  const button = buttons[0]
  if (!button) throw new Error(`no ${where} button labelled ${label}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function modeButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

describe('the mode switch', () => {
  it('offers the workbench, the canvas and the product shots mode', () => {
    act(() => root.render(<Header />))

    expect(modeButton('工作台').getAttribute('aria-pressed')).toBe('true')
    expect(modeButton('创作')).toBeTruthy()
    expect(modeButton('商品图')).toBeTruthy()
    expect([...document.querySelectorAll('button[aria-pressed]')]).toHaveLength(3)
  })

  it('switches to the product shots mode when it is picked', () => {
    act(() => root.render(<Header />))

    act(() => {
      modeButton('商品图').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useStore.getState().appMode).toBe('product')
    expect(modeButton('商品图').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('logging out', () => {
  it('asks before it goes, and passes on whether to clear the local data', () => {
    const logout = vi.fn(async () => {})
    renderLoggedIn(logout)

    click('退出')
    expect(logout).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('同时清除本机数据')

    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
    act(() => box?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    click('退出', 'dialog')

    expect(logout).toHaveBeenCalledWith(true)
  })
})
