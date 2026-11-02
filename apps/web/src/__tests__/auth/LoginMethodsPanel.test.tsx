// @vitest-environment jsdom
import type { AuthUserView, LoginMethodsView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import { LoginMethodsPanel } from '../../auth/LoginMethodsPanel'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const GOOGLE_PROVIDER = {
  providers: [{ id: 'google', label: 'Google' }],
  loginMethods: { password: true, registration: true },
}

function stubBff(methods: LoginMethodsView, mutation?: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
      if (input.includes('/api/auth/login-methods')) return Response.json(methods)
      if (input.endsWith('/api/me/cli-connections')) return Response.json({ connections: [] })
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

async function render(
  user: AuthUserView | null = { id: 'user-one', username: 'creator' },
): Promise<void> {
  await act(async () => {
    root.render(
      <AuthContextProvider value={{ enabled: true, user, login: () => {}, logout: async () => {} }}>
        <LoginMethodsPanel onClose={() => {}} />
      </AuthContextProvider>,
    )
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

    expect(document.body.textContent).toContain(
      '该第三方账号已绑定到其他账户。请退出当前账户，直接使用 Google 登录原账户。',
    )
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

  it('lists CLI connections in account settings and revokes only the selected session', async () => {
    const connections = [
      { id: 'cli-one', client_name: 'Laptop CLI', created_at: 1, last_used_at: null },
      { id: 'cli-two', client_name: 'Desktop CLI', created_at: 2, last_used_at: 3 },
    ]
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
      if (input.endsWith('/api/auth/login-methods'))
        return Response.json({ password: true, identities: [] })
      if (input.endsWith('/api/me/cli-connections')) return Response.json({ connections })
      if (input.endsWith('/api/me/cli-connections/cli-one')) return Response.json({ ok: true })
      throw new Error(`Unexpected request: ${input}`)
    })
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(document.body.textContent).toContain('已连接的 CLI')
    expect(document.body.textContent).toContain('Laptop CLI')
    expect(document.body.textContent).toContain('尚未使用')
    expect(document.body.textContent).toContain('最近使用')
    await clickButton('撤销连接')
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://api.example.com/api/me/cli-connections/cli-one',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
    expect(document.body.textContent).not.toContain('Laptop CLI')
    expect(document.body.textContent).toContain('Desktop CLI')
    expect(document.body.textContent).toContain('已撤销连接')
  })

  it('keeps a failed revocation visible and permits retry without duplicate submits', async () => {
    let resolveRevoke!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveRevoke = resolve
    })
    let mutations = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
        if (input.includes('/api/auth/login-methods'))
          return Response.json({ password: true, identities: [] })
        if (init?.method === 'DELETE') {
          mutations += 1
          return mutations === 1 ? pending : Response.json({ ok: true })
        }
        return Response.json({
          connections: [
            { id: 'cli-one', client_name: 'Laptop CLI', created_at: 1, last_used_at: null },
          ],
        })
      }),
    )
    await render()
    const revoke = Array.from(document.body.querySelectorAll('button')).find(
      (item) => item.textContent === '撤销连接',
    )
    if (!revoke) throw new Error('Missing revoke action')
    await act(async () => {
      revoke.click()
      revoke.click()
    })
    expect(mutations).toBe(1)
    expect(revoke.disabled).toBe(true)
    await act(async () => resolveRevoke(Response.json({ error: 'unavailable' }, { status: 503 })))
    expect(document.body.textContent).toContain('未能撤销连接，请重试。')
    expect(document.body.textContent).toContain('Laptop CLI')
    await clickButton('撤销连接')
    expect(mutations).toBe(2)
    expect(document.body.textContent).toContain('暂无已连接的 CLI')
  })

  it('retries connection loading without replacing the account settings form', async () => {
    let loads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
        if (input.includes('/api/auth/login-methods'))
          return Response.json({ password: true, identities: [] })
        loads += 1
        if (loads === 1) throw new TypeError('Network unavailable')
        return Response.json({ connections: [] })
      }),
    )
    await render()
    expect(document.body.textContent).toContain('暂时无法读取连接，请重试。')
    expect(buttonLabels()).toContain('更新密码')
    const refresh = document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新连接"]')
    if (!refresh) throw new Error('Missing refresh action')
    await act(async () => refresh.click())
    expect(document.body.textContent).toContain('暂无已连接的 CLI')
    expect(document.body.textContent).not.toContain('暂时无法读取连接，请重试。')
  })

  it('hides only the CLI section when the deployment does not offer CLI access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
        if (input.includes('/api/auth/login-methods'))
          return Response.json({ password: true, identities: [] })
        return Response.json({ error: 'capability_unavailable' }, { status: 404 })
      }),
    )
    await render()
    expect(document.body.textContent).not.toContain('已连接的 CLI')
    expect(buttonLabels()).toContain('更新密码')
  })

  it('drops the old account connection list and ignores its delayed refresh after an account switch', async () => {
    let resolveOld!: (response: Response) => void
    const pendingOld = new Promise<Response>((resolve) => {
      resolveOld = resolve
    })
    let loads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/api/auth/oauth/providers')) return Response.json(GOOGLE_PROVIDER)
        if (input.includes('/api/auth/login-methods'))
          return Response.json({ password: true, identities: [] })
        loads += 1
        if (loads === 2) return pendingOld
        return Response.json({
          connections: [
            {
              id: loads === 1 ? 'old-cli' : 'new-cli',
              client_name: loads === 1 ? 'Old account CLI' : 'New account CLI',
              created_at: 1,
              last_used_at: null,
            },
          ],
        })
      }),
    )
    await render()
    expect(document.body.textContent).toContain('Old account CLI')
    const refresh = document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新连接"]')
    if (!refresh) throw new Error('Missing refresh action')
    await act(async () => refresh.click())
    await render({ id: 'user-two', username: 'another-creator' })
    expect(document.body.textContent).not.toContain('Old account CLI')
    expect(document.body.textContent).toContain('New account CLI')
    await act(async () =>
      resolveOld(
        Response.json({
          connections: [
            {
              id: 'old-cli',
              client_name: 'Old account CLI',
              created_at: 1,
              last_used_at: null,
            },
          ],
        }),
      ),
    )
    expect(document.body.textContent).not.toContain('Old account CLI')
    expect(document.body.textContent).toContain('New account CLI')
    await render(null)
    expect(document.body.textContent).not.toContain('New account CLI')
    expect(document.body.textContent).not.toContain('已连接的 CLI')
  })
})

it('hides password setup and nonallowed providers under provider-only policy', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/me/cli-connections')) return Response.json({ connections: [] })
      return Response.json(
        input.includes('/api/auth/oauth/providers')
          ? {
              providers: [{ id: 'enterprise', label: 'Enterprise' }],
              loginMethods: { password: false, registration: false },
            }
          : {
              password: true,
              identities: [{ provider: 'enterprise', email: 'person@example.com', linked_at: 1 }],
            },
      )
    }),
  )
  await render()
  expect(document.querySelector('form')).toBeNull()
  expect(document.querySelector('input')).toBeNull()
  expect(document.body.textContent).not.toContain('Google')
  expect(document.body.textContent).toContain('person@example.com')
})
