import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LoginForm } from '../../components/LoginForm'
import { ReasonDialog } from '../../features/announcements/ReasonDialog'
import { SaveStatus } from '../../features/billing/SettingsPanel'
import { ConfirmDialog } from '../../features/inspirations/ConfirmDialog'
import { ApiError } from '../../lib/api-client'

describe('Admin UX Batch 4 regressions', () => {
  it('renders error inside ReasonDialog and blocks Escape while pending', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ReasonDialog
        open
        title="发布公告"
        description="原因会写进审计记录。"
        confirmLabel="确认发布"
        pending
        error="先写标题"
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('先写标题')
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('blocks closing inspirations ConfirmDialog while pending', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmDialog
        open
        title="删除分类"
        description="不可恢复"
        confirmLabel="删除"
        destructive
        pending
        onConfirm={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    )

    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('maps raw HTTP ApiError statuses to friendly messages in billing SaveStatus', () => {
    render(<SaveStatus pending={false} success={false} error={new ApiError(500, null)} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).not.toContain('HTTP 500')
    expect(alert.textContent).toContain('服务暂不可用')
  })

  it('toggles password visibility in admin LoginForm', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={queryClient}>
        <LoginForm onSuccess={vi.fn()} />
      </QueryClientProvider>,
    )

    const input = screen.getByLabelText<HTMLInputElement>('密码')
    expect(input.type).toBe('password')

    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(input.type).toBe('text')

    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(input.type).toBe('password')
  })
})
