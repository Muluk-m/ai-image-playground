// @vitest-environment jsdom
import type { LoginMethodsView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginMethodsPanel } from '../../auth/LoginMethodsPanel'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const GOOGLE_PROVIDER = { providers: [{ id: 'google', label: 'Google' }] }

function stubBff(methods: LoginMethodsView, mutation?: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
      if (input.includes('/api/auth/login-methods')) return Response.json(methods)
      if (init?.method) return mutation?.() ?? Response.json({ ok: true })
      return new Response('{}', { status: 404 })
    }),
  )
}

function buttonLabels(): string[] {
  return Array.from(document.body.querySelectorAll('button')).map(
    (button) => button.textContent ?? '',
  )
}

async function clickButton(label: string): Promise<void> {
  const target = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  )
  await act(async () => {
    target?.click()
  })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<LoginMethodsPanel onClose={() => {}} />)
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  window.history.replaceState(null, '', '/')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('LoginMethodsPanel', () => {
  it('offers a first password without asking for the current one', async () => {
    stubBff({
      password: false,
      identities: [{ provider: 'google', email: 'creator@example.com', linked_at: 1 }],
    })
    await render()

    expect(buttonLabels()).toContain('设置密码')
    expect(document.body.querySelector('input[name="current-password"]')).toBeNull()
    expect(document.body.querySelector('input[name="new-password"]')).not.toBeNull()
  })

  it('requires the current password once the account has one', async () => {
    stubBff({ password: true, identities: [] })
    await render()

    expect(buttonLabels()).toContain('更新密码')
    expect(document.body.querySelector('input[name="current-password"]')).not.toBeNull()
  })

  it('offers to unlink a bound provider and to bind an unbound one', async () => {
    stubBff({
      password: true,
      identities: [{ provider: 'google', email: 'creator@example.com', linked_at: 1 }],
    })
    await render()

    expect(buttonLabels()).toContain('解绑')
    expect(document.body.textContent).toContain('creator@example.com')

    await act(async () => root.unmount())
    root = createRoot(host)
    stubBff({ password: true, identities: [] })
    await render()

    expect(buttonLabels()).toContain('绑定')
    expect(document.body.textContent).toContain('未绑定')
  })

  it('drops a bound provider and reflects the reload', async () => {
    let methods: LoginMethodsView = {
      password: true,
      identities: [{ provider: 'google', email: 'creator@example.com', linked_at: 1 }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
        if (init?.method === 'DELETE') {
          methods = { password: true, identities: [] }
          return Response.json({ ok: true })
        }
        if (input.includes('/api/auth/login-methods')) return Response.json(methods)
        return new Response('{}', { status: 404 })
      }),
    )
    await render()

    await clickButton('解绑')

    expect(document.body.textContent).toContain('已解绑')
    expect(buttonLabels()).toContain('绑定')
  })

  it('refuses to drop the only login method', async () => {
    stubBff(
      {
        password: false,
        identities: [{ provider: 'google', email: 'solo@example.com', linked_at: 1 }],
      },
      () => Response.json({ error: 'last_login_method' }, { status: 409 }),
    )
    await render()

    await clickButton('解绑')

    expect(document.body.textContent).toContain('解绑后将无法登录，请先设置密码')
  })

  it('shows a link failure once and clears it from the address bar', async () => {
    stubBff({ password: true, identities: [] })
    window.history.replaceState(null, '', '/?auth_link_error=identity_taken&keep=1')
    await render()

    expect(document.body.textContent).toContain('该第三方账号已绑定到其他账户')
    expect(window.location.search).toBe('?keep=1')
  })

  it('confirms a successful link with the provider label', async () => {
    stubBff({
      password: true,
      identities: [{ provider: 'google', email: 'creator@example.com', linked_at: 1 }],
    })
    window.history.replaceState(null, '', '/?auth_link=google')
    await render()

    expect(document.body.textContent).toContain('已绑定 Google')
    expect(window.location.search).toBe('')
  })
})
