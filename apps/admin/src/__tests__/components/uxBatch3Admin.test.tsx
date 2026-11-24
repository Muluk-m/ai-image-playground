import type { GptDirectAdminView } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DangerConfirmDialog } from '../../components/DangerConfirmDialog'
import { UserFormDialog } from '../../components/UserFormDialog'
import { TooltipProvider } from '../../components/ui/tooltip'
import { GptDirectPanel } from '../../features/providers/GptDirectPanel'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeGptDirectView(): GptDirectAdminView {
  return {
    generated_at: Date.now(),
    currency_note: 'usage',
    days: 7,
    source: 'admin',
    revision: 1,
    fingerprint_mac_source: 'FINGERPRINT_SECRET',
    writable: true,
    disabled_reason: null,
    keys: [
      {
        id: 'key-1',
        ordinal: 0,
        fingerprint: 'fp-1',
        label: 'sk-proj-****1234',
        enabled: true,
        source: 'admin',
        status: 'cooldown',
        disabled_reason: null,
        budget_usd: 200,
        budget_micro_usd: 200_000_000,
        spent_micro_usd: 10_000_000,
        cooldown_until: Date.now() + 60_000,
        last_error: '429 rate limited',
        last_error_at: Date.now(),
      },
    ],
    total_spent_micro_usd: 10_000_000,
    total_budget_micro_usd: 200_000_000,
    remaining_micro_usd: 190_000_000,
    daily: [],
    official: null,
  }
}

describe('Admin UX Batch 3 regressions', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders inline alert inside DangerConfirmDialog when error is provided', () => {
    render(
      <DangerConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="确认下架?"
        impact="下架后不再可见"
        confirmLabel="确认下架"
        error="保存失败，请刷新后重试"
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败，请刷新后重试')
  })

  it('toggles password visibility in UserFormDialog', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={queryClient}>
        <UserFormDialog mode="create" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    )

    const passwordInput = screen.getByLabelText<HTMLInputElement>('初始密码')
    expect(passwordInput.type).toBe('password')

    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(passwordInput.type).toBe('text')

    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(passwordInput.type).toBe('password')
  })

  it('requires confirmation before deleting a GPT direct key and validates invalid budgets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, makeGptDirectView()))
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const user = userEvent.setup()

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <GptDirectPanel view={makeGptDirectView()} />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    // Cooldown keys expose restore action
    expect(screen.getByRole('button', { name: '恢复' })).toBeTruthy()

    // Invalid budget on add-key form shows inline alert rather than silently ignoring
    await user.type(screen.getByLabelText('新密钥'), 'sk-proj-test-key')
    const budgetInput = screen.getByLabelText<HTMLInputElement>('月预算')
    await user.clear(budgetInput)
    await user.type(budgetInput, '0')
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByRole('alert')).toHaveTextContent('大于 0 的整数')
    expect(fetchMock).not.toHaveBeenCalled()

    // Clicking delete opens confirmation dialog before calling API
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('删除 OpenAI 直连密钥')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/gpt-direct/keys/key-1',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })
})
