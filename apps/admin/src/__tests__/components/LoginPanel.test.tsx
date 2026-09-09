import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LoginPanel, type LoginPanelProps } from '../../components/LoginPanel'

function stubMethods(googleLogin: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ google_login: googleLogin, password_login: !googleLogin }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

function renderPanel(props: Partial<LoginPanelProps> = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <LoginPanel onSuccess={vi.fn()} {...props} />
    </QueryClientProvider>,
  )
}

describe('LoginPanel', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Google 登录开启时只渲染 Google 按钮', async () => {
    stubMethods(true)
    renderPanel({ redirectTo: '/tasks' })

    const link = await screen.findByRole('link', { name: '使用 Google 登录' })
    expect(link).toHaveAttribute('href', '/api/auth/google?redirect=%2Ftasks')
    expect(screen.queryByLabelText('密码')).toBeNull()
  })

  it('Google 登录关闭时回落到密码表单', async () => {
    stubMethods(false)
    renderPanel()

    expect(await screen.findByLabelText('密码')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '使用 Google 登录' })).toBeNull()
  })

  it('回调错误码渲染对应文案', async () => {
    stubMethods(true)
    renderPanel({ error: 'not_allowed' })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('这个 Google 账号没有权限')
    })
  })
})
