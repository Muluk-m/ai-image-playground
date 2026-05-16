import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LoginForm } from '../../components/LoginForm'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderForm(onSuccess = vi.fn()): {
  onSuccess: typeof onSuccess
  user: ReturnType<typeof userEvent.setup>
} {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <LoginForm onSuccess={onSuccess} />
    </QueryClientProvider>,
  )
  return { onSuccess, user: userEvent.setup() }
}

describe('LoginForm', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('成功提交 → 调 onSuccess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    )
    const { onSuccess, user } = renderForm()
    await user.type(screen.getByLabelText('密码'), 'right-pw')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it('401 → 显示 "密码错误"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_password' })),
    )
    const { onSuccess, user } = renderForm()
    await user.type(screen.getByLabelText('密码'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('密码错误')
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('429 → 显示 "登录过于频繁"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(429, { error: 'rate_limited' })),
    )
    const { onSuccess, user } = renderForm()
    await user.type(screen.getByLabelText('密码'), 'x')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('登录过于频繁')
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('空密码 → 提交按钮 disabled', () => {
    renderForm()
    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled()
  })
})
