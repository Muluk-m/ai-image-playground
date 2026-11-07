// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  test: vi.fn(),
  data: {
    writable: true,
    disabledReason: null,
    warning: null,
    secrets: [
      {
        id: 'openai_direct' as const,
        label: 'OpenAI 直连',
        configured: true,
        source: 'admin' as const,
        updatedAt: Date.UTC(2026, 0, 1),
        updatedBy: 'admin',
      },
    ],
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: state.setQueryData }),
}))
vi.mock('../../../lib/api-client', () => ({ ApiError: class ApiError extends Error {} }))
vi.mock('../../../lib/queries', () => ({
  clearUpstreamSecret: state.clear,
  replaceUpstreamSecret: state.replace,
  testUpstreamSecret: state.test,
  upstreamSecretsQueryKey: ['upstream-secrets'],
  useUpstreamSecrets: () => ({
    data: state.data,
    isPending: false,
    isError: false,
  }),
}))
vi.mock('../../../components/Page', () => ({
  ErrorState: ({ label }: { label: string }) => <div>{label}</div>,
  PendingState: ({ label }: { label: string }) => <div>{label}</div>,
}))

import { UpstreamSecretsPanel } from '../../../features/providers/UpstreamSecretsPanel'

describe('UpstreamSecretsPanel', () => {
  beforeEach(() => {
    state.replace.mockReset()
    state.replace.mockResolvedValue(state.data)
    state.clear.mockReset()
    state.test.mockReset()
    state.test.mockResolvedValue({ ok: true, httpStatus: null })
    state.setQueryData.mockReset()
  })

  it('never renders the existing secret and saves only a newly entered value', async () => {
    const secret = 'secret-value-that-must-not-render'
    render(<UpstreamSecretsPanel />)

    expect(screen.queryByText(secret)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('OpenAI 直连 新密钥'), {
      target: { value: secret },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('openai_direct', secret))
    expect(screen.queryByText(secret)).not.toBeInTheDocument()
    expect(state.setQueryData).toHaveBeenCalledWith(['upstream-secrets'], state.data)
  })

  it('tests a draft without saving it', async () => {
    render(<UpstreamSecretsPanel />)
    fireEvent.change(screen.getByLabelText('OpenAI 直连 新密钥'), {
      target: { value: 'probe-only' },
    })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    await waitFor(() => expect(state.test).toHaveBeenCalledWith('openai_direct', 'probe-only'))
    expect(state.replace).not.toHaveBeenCalled()
    expect(screen.getByText('连接成功')).toBeInTheDocument()
  })
})
