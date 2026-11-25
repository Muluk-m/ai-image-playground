// @vitest-environment jsdom

import type { AgentModelSettingsView, GptDirectAdminView } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterBar } from '@/components/FilterBar'
import { ErrorState } from '@/components/Page'
import { AgentModelSettingsForm } from '@/features/agent-models/AgentModelSettingsForm'
import { ApiError, formatAdminError, UnauthorizedError } from '@/lib/api-client'

const directState = vi.hoisted(() => ({
  invalidateQueries: vi.fn(async () => {}),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useRouter: () => null,
  }
})

vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries')>()
  return {
    ...actual,
    updateGptDirectKey: directState.update,
    deleteGptDirectKey: directState.remove,
  }
})

import { GptDirectPanel } from '@/features/providers/GptDirectPanel'

const GPT_VIEW: GptDirectAdminView = {
  generated_at: 1,
  currency_note: 'usage',
  days: 7,
  source: 'admin',
  revision: 2,
  fingerprint_mac_source: 'INTERNAL_API_TOKEN',
  writable: true,
  disabled_reason: null,
  keys: [
    {
      id: 'key-1',
      ordinal: 1,
      fingerprint: 'abcd1234',
      label: 'abcd1234 · 6789',
      enabled: true,
      source: 'admin',
      status: 'available',
      disabled_reason: null,
      budget_usd: 200,
      budget_micro_usd: 200_000_000,
      spent_micro_usd: 10_000_000,
      cooldown_until: null,
      last_error: null,
      last_error_at: null,
    },
  ],
  total_spent_micro_usd: 10_000_000,
  total_budget_micro_usd: 200_000_000,
  remaining_micro_usd: 190_000_000,
  daily: [],
  official: null,
}

describe('Batch 5 Admin UX polish', () => {
  beforeEach(() => {
    directState.update.mockReset()
    directState.remove.mockReset()
  })

  it('formats raw HTTP and network errors into friendly Chinese and exposes Retry on ErrorState', () => {
    expect(formatAdminError(new UnauthorizedError(null))).toBe('登录已过期，请重新登录')
    expect(formatAdminError(new ApiError(500, null))).toBe('服务暂时不可用，请稍后重试')
    expect(formatAdminError(new ApiError(403, null))).toBe('当前账号没有执行该操作的权限')
    expect(formatAdminError(new TypeError('Failed to fetch'))).toBe(
      '网络连接失败，请检查网络后重试',
    )

    const onRetry = vi.fn()
    render(<ErrorState label="加载用户失败" error={new ApiError(500, null)} onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('加载用户失败：服务暂时不可用，请稍后重试')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('clears FilterBar search on Escape without firing during IME composition', () => {
    const onSearch = vi.fn()
    render(
      <FilterBar
        savedViewKey="users-test"
        search="alice"
        onSearch={onSearch}
        searchPlaceholder="搜索用户名"
        chips={[]}
        definitions={[{ key: 'registeredFrom', label: '注册起点', kind: 'datetime' }]}
        values={{ registeredFrom: '' }}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const input = screen.getByPlaceholderText('搜索用户名') as HTMLInputElement
    expect(input.value).toBe('alice')

    // During IME composition (keyCode 229), Escape must not clear.
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    expect(input.value).toBe('alice')
    expect(onSearch).not.toHaveBeenCalled()

    // Normal Escape clears draft and resets committed search.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(onSearch).toHaveBeenCalledWith('')
  })

  it('requires confirmation before disabling an active GPT direct key and keeps dialog open on error', async () => {
    directState.update
      .mockRejectedValueOnce(new ApiError(500, null))
      .mockResolvedValueOnce(GPT_VIEW)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <GptDirectPanel view={GPT_VIEW} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(directState.update).not.toHaveBeenCalled()
    expect(screen.getByText('停用 OpenAI 直连密钥')).toBeInTheDocument()

    // First attempt fails: dialog remains open and shows inline error.
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }))
    await waitFor(() =>
      expect(directState.update).toHaveBeenCalledWith('key-1', { enabled: false }),
    )
    expect(screen.getByText('停用 OpenAI 直连密钥')).toBeInTheDocument()

    // Second attempt succeeds: dialog closes.
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }))
    await waitFor(() => expect(screen.queryByText('停用 OpenAI 直连密钥')).not.toBeInTheDocument())
  })

  it('requires inline confirmation before deleting an unused Agent provider', () => {
    const view: AgentModelSettingsView = {
      revision: 1,
      credentialReady: { p1: true, p2: true },
      templates: [{ id: 'custom', name: '自定义 API', baseUrl: '', models: [] }],
      settings: {
        providers: [
          {
            id: 'p1',
            name: 'Primary',
            template: 'custom',
            baseUrl: 'https://a.example/v1',
            secretRef: 'A_KEY',
            models: [
              {
                id: 'm1',
                name: 'M1',
                api: 'openai-completions',
                contextWindow: 128000,
                maxTokens: 16000,
                imageInput: true,
                reasoningLevels: ['off'],
              },
            ],
          },
          {
            id: 'p2',
            name: 'Unused',
            template: 'custom',
            baseUrl: 'https://b.example/v1',
            secretRef: 'B_KEY',
            models: [],
          },
        ],
        profiles: {
          default: { providerId: 'p1', modelId: 'm1', reasoning: 'off' },
          fast: { providerId: 'p1', modelId: 'm1', reasoning: 'off' },
          medium: { providerId: 'p1', modelId: 'm1', reasoning: 'off' },
          deep: { providerId: 'p1', modelId: 'm1', reasoning: 'off' },
        },
      },
    }

    render(
      <AgentModelSettingsForm initial={view} save={async () => {}} pending={false} error={null} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除 Unused' }))
    // Still present until confirmed
    expect(screen.getByRole('heading', { name: 'Unused' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(screen.queryByRole('heading', { name: 'Unused' })).not.toBeInTheDocument()
  })
})
