// @vitest-environment jsdom
import type { AuthUserView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import type * as LoginPromptModule from '../../../auth/loginPrompt'
import CliDevicePage from '../../../features/cli/CliDevicePage'
import { oauthStartUrl } from '../../../lib/authClient'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const { promptLogin } = vi.hoisted(() => ({ promptLogin: vi.fn() }))
vi.mock('../../../auth/loginPrompt', async (importOriginal) => ({
  ...(await importOriginal<typeof LoginPromptModule>()),
  promptLogin,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const USER: AuthUserView = { id: 'user-1', username: 'creator' }
const AUTHORIZATION = { client_name: 'Muvloom CLI', scopes: ['images:read', 'images:write'] }
let host: HTMLDivElement
let root: Root

function deferred() {
  let resolve!: (response: Response) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function render(user: AuthUserView | null = USER) {
  await act(async () => {
    root.render(
      <AuthContextProvider value={{ enabled: true, user, login: () => {}, logout: async () => {} }}>
        <CliDevicePage />
      </AuthContextProvider>,
    )
  })
}

function button(label: string): HTMLButtonElement {
  const target = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  )
  if (!target) throw new Error(`Missing button: ${label}`)
  return target
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  window.history.replaceState(null, '', '/device?user_code=BCDF-GHJK')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  promptLogin.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('CliDevicePage', () => {
  it.each([
    ['授权', 'approve', '已授权，回到终端继续。'],
    ['拒绝', 'deny', '已拒绝这次连接。'],
  ])('sends the explicit %s decision with the displayed code', async (label, decision, outcome) => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) =>
      Response.json(init?.method === 'POST' ? { ok: true } : AUTHORIZATION),
    )
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(host.textContent).toContain('Muvloom CLI')
    expect(host.textContent).toContain('提交与取消生成任务（会消耗积分）')
    await act(async () => button(label).click())
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://api.example.com/api/cli/device',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ user_code: 'BCDF-GHJK', decision }),
      }),
    )
    expect(host.querySelector('[role="status"]')?.textContent).toBe(outcome)
  })

  it('sends only the first decision when both buttons are clicked in the same frame', async () => {
    const pending = deferred()
    const fetcher = vi.fn((_input: string, init?: RequestInit) =>
      init?.method === 'POST' ? pending.promise : Promise.resolve(Response.json(AUTHORIZATION)),
    )
    vi.stubGlobal('fetch', fetcher)
    await render()
    const approve = button('授权')
    const deny = button('拒绝')
    await act(async () => {
      approve.click()
      approve.click()
      deny.click()
    })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await act(async () => pending.resolve(Response.json({ ok: true })))
    expect(host.textContent).toContain('已授权，回到终端继续。')
  })

  it('preserves an entered code and hash through the existing login and OAuth path', async () => {
    window.history.replaceState(null, '', '/device?keep=1#approval')
    const fetcher = vi.fn(async () => Response.json(AUTHORIZATION))
    vi.stubGlobal('fetch', fetcher)
    await render(null)
    const input = host.querySelector('input')
    if (!input) throw new Error('Missing code input')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'BCDF-GHJK',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('继续').click())
    await act(async () => button('登录后继续').click())
    expect(promptLogin).toHaveBeenCalledWith('gated-action')
    expect(fetcher).not.toHaveBeenCalled()
    expect(new URL(oauthStartUrl('google')).searchParams.get('return_to')).toBe(
      '/device?keep=1&user_code=BCDF-GHJK#approval',
    )
    await render(USER)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('user_code=BCDF-GHJK'),
      expect.anything(),
    )
    expect(host.textContent).toContain('Muvloom CLI')
  })

  it.each([
    'lookup',
    'decision',
  ])('shows expired codes during %s without offering another decision', async (stage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) =>
        stage === 'lookup' || init?.method === 'POST'
          ? Response.json({ error: 'invalid_code' }, { status: 404 })
          : Response.json(AUTHORIZATION),
      ),
    )
    await render()
    if (stage === 'decision') await act(async () => button('授权').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已过期')
    expect(
      Array.from(host.querySelectorAll('button')).some((item) => item.textContent === '授权'),
    ).toBe(false)
  })

  it.each([
    'lookup',
    'decision',
  ])('retries a failed %s by reloading authorization before allowing another decision', async (stage) => {
    let failed = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) => {
        if (!failed && (stage === 'lookup' || init?.method === 'POST')) {
          failed = true
          throw new TypeError('Network unavailable')
        }
        return Response.json(init?.method === 'POST' ? { ok: true } : AUTHORIZATION)
      }),
    )
    await render()
    if (stage === 'decision') await act(async () => button('授权').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法完成')
    await act(async () => button('重试').click())
    expect(host.textContent).toContain('Muvloom CLI')
    await act(async () => button('拒绝').click())
    expect(host.textContent).toContain('已拒绝这次连接。')
  })

  it.each([
    'lookup',
    'decision',
  ])('ignores a stale %s response after navigation to a different code', async (stage) => {
    const old = deferred()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (input.includes('NEWC-ODE2'))
          return Promise.resolve(Response.json({ ...AUTHORIZATION, client_name: 'New CLI' }))
        if (stage === 'lookup' || init?.method === 'POST') return old.promise
        return Promise.resolve(Response.json(AUTHORIZATION))
      }),
    )
    await render()
    if (stage === 'decision') await act(async () => button('授权').click())
    await act(async () => {
      window.history.pushState(null, '', '/device?user_code=NEWC-ODE2')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(host.textContent).toContain('New CLI')
    await act(async () =>
      old.resolve(Response.json(stage === 'lookup' ? AUTHORIZATION : { ok: true })),
    )
    expect(host.textContent).toContain('New CLI')
    expect(host.textContent).not.toContain('已授权，回到终端继续。')
    expect(button('授权')).toBeDefined()
  })

  it('clears pending permissions on logout and ignores the old account decision', async () => {
    const old = deferred()
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init?: RequestInit) =>
        init?.method === 'POST' ? old.promise : Promise.resolve(Response.json(AUTHORIZATION)),
      ),
    )
    await render()
    await act(async () => button('授权').click())
    await render(null)
    await act(async () => old.resolve(Response.json({ ok: true })))
    expect(host.textContent).not.toContain('已授权，回到终端继续。')
    expect(button('登录后继续')).toBeDefined()
  })
})
