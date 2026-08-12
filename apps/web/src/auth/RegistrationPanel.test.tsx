// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapClientCapabilities } from '../lib/clientCapabilities'
import { LoginScreen } from './LoginScreen'
import { RegistrationPanel } from './RegistrationPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function input(name: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)
  if (!element) throw new Error(`missing input: ${name}`)
  return element
}

function setInput(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('RegistrationPanel', () => {
  it('shows the registration fields and returns to login', () => {
    const onBack = vi.fn()
    act(() => {
      root.render(
        <RegistrationPanel pending={false} error={null} onBack={onBack} onRegister={vi.fn()} />,
      )
    })

    expect(host.textContent).toContain('创建账户')
    expect(input('username').autocomplete).toBe('email')
    expect(input('password').autocomplete).toBe('new-password')
    expect(input('confirmPassword').autocomplete).toBe('new-password')

    const back = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('返回登录'),
    )
    act(() => back?.click())
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('submits an email identity with matching credentials and rejects a mismatched confirmation', () => {
    const onRegister = vi.fn()
    act(() => {
      root.render(
        <RegistrationPanel pending={false} error="" onBack={vi.fn()} onRegister={onRegister} />,
      )
    })

    act(() => {
      setInput(input('username'), 'Creator@Example.com')
      setInput(input('password'), 'fixture-phrase')
      setInput(input('confirmPassword'), 'different-phrase')
    })
    act(() => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true })))
    expect(onRegister).not.toHaveBeenCalled()
    expect(host.textContent).toContain('两次输入的密码不一致')

    act(() => setInput(input('confirmPassword'), 'fixture-phrase'))
    act(() => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true })))
    expect(onRegister).toHaveBeenCalledWith({
      username: 'Creator@Example.com',
      password: 'fixture-phrase',
    })
  })

  it('disables actions while pending and displays the server error', () => {
    act(() => {
      root.render(
        <RegistrationPanel
          pending
          error="该用户名已被使用"
          onBack={vi.fn()}
          onRegister={vi.fn()}
        />,
      )
    })

    expect(host.textContent).toContain('该用户名已被使用')
    expect(Array.from(host.querySelectorAll('button')).every((button) => button.disabled)).toBe(
      true,
    )
  })
})

describe('LoginScreen registration entry', () => {
  it('opens the registration panel when the deployment enables self-registration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          'accounts:login': true,
          'accounts:self-register': true,
          'billing:credits': true,
          'generation:byok': false,
          'quota:daily': false,
        }),
      ),
    )
    await bootstrapClientCapabilities(true, '')
    act(() => root.render(<LoginScreen />))

    expect(host.querySelector('.auth-showcase')).toBeDefined()
    expect(host.querySelector('.auth-panel')).toBeDefined()
    expect(host.textContent).toContain('释放创意，让想象成真')
    expect(host.textContent).toContain('邮箱地址')

    const registrationEntry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '立即注册',
    )
    expect(registrationEntry).toBeDefined()
    act(() => registrationEntry?.click())

    expect(host.querySelector('h1')?.textContent).toBe('创建账户')
    expect(input('confirmPassword')).toBeDefined()
  })
})
