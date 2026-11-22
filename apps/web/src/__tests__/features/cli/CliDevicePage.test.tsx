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

const { promptLogin, leaveTo } = vi.hoisted(() => ({ promptLogin: vi.fn(), leaveTo: vi.fn() }))
vi.mock('../../../features/cli/loopbackRedirect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../features/cli/loopbackRedirect')>()),
  leaveTo,
}))
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
  leaveTo.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('CliDevicePage', () => {
  it.each([
    ['允许', 'approve', '已授权。'],
    ['这不是我发起的 —— 拒绝', 'deny', '已拒绝这次连接。'],
  ])('sends the explicit %s decision with the displayed code', async (label, decision, outcome) => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) =>
      Response.json(init?.method === 'POST' ? { ok: true } : AUTHORIZATION),
    )
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(host.textContent).toContain('Muvloom CLI · BCDF-GHJK')
    // 已登录用户直接进入授权确认，步骤条跳过「登录」。
    expect(host.querySelector('[aria-label="授权步骤"]')?.textContent).not.toContain('登录')
    // 按 scopes 动态展示能力胶囊（本用例不含 media:write，不展示「参考图编辑」），并默认显示消耗积分提示。
    expect(host.textContent).toContain('生成图像')
    expect(host.textContent).toContain('查询与下载')
    expect(host.textContent).not.toContain('参考图编辑')
    expect(host.textContent).toContain('生成图片会消耗当前账户积分。')
    // 详细权限默认折叠，点击「查看所有权限」后展开。
    expect(host.textContent).not.toContain('提交与取消生成任务（消耗账户积分）')
    await act(async () => button('查看所有权限').click())
    expect(host.textContent).toContain('提交与取消生成任务（消耗账户积分）')
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
    if (decision === 'deny') {
      expect(host.querySelector('[aria-label="授权步骤"]')).toBeNull()
    }
  })

  it('sends the browser back to the CLI that opened it, with its state', async () => {
    const state = 'cli-state-0123456789abcdef'
    window.history.replaceState(null, '', `/device?user_code=BCDF-GHJK&state=${state}`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) =>
        Response.json(
          init?.method === 'POST'
            ? { ok: true, redirect_to: 'http://127.0.0.1:53682/callback?code=one-time' }
            : AUTHORIZATION,
        ),
      ),
    )
    await render()
    expect(host.textContent).toContain('Muvloom CLI')
    expect(host.textContent).not.toContain('BCDF-GHJK')
    await act(async () => button('允许').click())
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith(
      'https://api.example.com/api/cli/device',
      expect.objectContaining({
        body: JSON.stringify({ user_code: 'BCDF-GHJK', decision: 'approve', loopback: true }),
      }),
    )
    expect(leaveTo).toHaveBeenCalledWith(
      `http://127.0.0.1:53682/callback?code=one-time&state=${state}`,
    )
    expect(host.textContent).toContain('正在处理…')
  })

  it.each([
    [
      'without a state, as when the code was typed on another device',
      '',
      'http://127.0.0.1:53682/callback?code=c',
    ],
    [
      'to anywhere but a loopback callback',
      '&state=cli-state-0123456789abcdef',
      'https://evil.example/callback?code=c',
    ],
  ])('does not redirect %s', async (_name, query, redirectTo) => {
    window.history.replaceState(null, '', `/device?user_code=BCDF-GHJK${query}`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) =>
        Response.json(
          init?.method === 'POST' ? { ok: true, redirect_to: redirectTo } : AUTHORIZATION,
        ),
      ),
    )
    await render()
    await act(async () => button('允许').click())
    expect(leaveTo).not.toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('已授权。')
  })

  it('says when the CLI could not finish, without offering to authorize again', async () => {
    window.history.replaceState(null, '', '/device?status=failed')
    vi.stubGlobal('fetch', vi.fn())
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      '连接没有完成，请回到原来的应用查看。',
    )
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('shows that the CLI finished connecting', async () => {
    window.history.replaceState(null, '', '/device?status=connected')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await render()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('已连接，可以回到原来的应用。')
    expect(host.querySelector('input')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns only after clicking and explains when the browser keeps the tab open', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string, init?: RequestInit) =>
          Response.json(init?.method === 'POST' ? { ok: true } : AUTHORIZATION),
        ),
      )
      await render()
      await act(async () => button('允许').click())
      expect(host.querySelector('[role="status"]')?.textContent).toBe('已授权。')
      expect(close).not.toHaveBeenCalled()
      await act(async () => button('关闭并返回').click())
      expect(close).toHaveBeenCalledTimes(1)
      expect(host.textContent).toContain('请关闭此页面，回到发起授权的应用继续。')
      expect(host.textContent).not.toContain('终端')
    } finally {
      close.mockRestore()
    }
  })

  it('sends only the first decision when both buttons are clicked in the same frame', async () => {
    const pending = deferred()
    const fetcher = vi.fn((_input: string, init?: RequestInit) =>
      init?.method === 'POST' ? pending.promise : Promise.resolve(Response.json(AUTHORIZATION)),
    )
    vi.stubGlobal('fetch', fetcher)
    await render()
    const approve = button('允许')
    const deny = button('这不是我发起的 —— 拒绝')
    await act(async () => {
      approve.click()
      approve.click()
      deny.click()
    })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await act(async () => pending.resolve(Response.json({ ok: true })))
    expect(host.textContent).toContain('已授权。')
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
    // 输入授权码后未登录，自动触发登录弹框（也可手动点「登录后继续」再次打开）。
    expect(promptLogin).toHaveBeenCalledWith('gated-action')
    expect(fetcher).not.toHaveBeenCalled()
    for (const provider of ['feishu', 'google', 'enterprise-sso']) {
      const start = new URL(oauthStartUrl(provider))
      expect(start.pathname).toBe(`/api/auth/oauth/${provider}/start`)
      expect(start.searchParams.get('return_to')).toBe(
        '/device?keep=1&user_code=BCDF-GHJK#approval',
      )
    }
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
    if (stage === 'decision') await act(async () => button('允许').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已过期')
    expect(
      Array.from(host.querySelectorAll('button')).some((item) => item.textContent === '允许'),
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
    if (stage === 'decision') await act(async () => button('允许').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法完成')
    await act(async () => button('重试').click())
    expect(host.textContent).toContain('Muvloom CLI')
    await act(async () => button('这不是我发起的 —— 拒绝').click())
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
    if (stage === 'decision') await act(async () => button('允许').click())
    await act(async () => {
      window.history.pushState(null, '', '/device?user_code=NEWC-ODE2')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(host.textContent).toContain('New CLI')
    await act(async () =>
      old.resolve(Response.json(stage === 'lookup' ? AUTHORIZATION : { ok: true })),
    )
    expect(host.textContent).toContain('New CLI')
    expect(host.textContent).not.toContain('已授权。')
    expect(button('允许')).toBeDefined()
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
    await act(async () => button('允许').click())
    await render(null)
    await act(async () => old.resolve(Response.json({ ok: true })))
    expect(host.textContent).not.toContain('已授权。')
    expect(button('登录后继续')).toBeDefined()
  })

  it('auto-opens login prompt when arriving signed out with user_code and surfaces unknown scopes directly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          client_name: 'Muvloom CLI',
          scopes: ['images:read', 'billing:admin'],
        }),
      ),
    )
    await render(null)
    expect(promptLogin).toHaveBeenCalledWith('gated-action')
    await render(USER)
    expect(host.textContent).toContain('billing:admin')
    expect(host.textContent).not.toContain('生成图片会消耗当前账户积分。')
  })
})
