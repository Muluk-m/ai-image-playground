// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api-client'

const state = vi.hoisted(() => {
  const data = {
    revision: 3,
    settings: [
      {
        key: 'cli:api',
        kind: 'capability' as const,
        name: 'CLI API',
        description: '开放命令行 API',
        domain: 'cli',
        editability: 'hot' as const,
        baseline: false,
        override: null,
        effective: false,
        reason: null,
        revision: 3,
      },
      {
        key: 'billing:chat-free',
        kind: 'capability' as const,
        name: '免费对话',
        description: '允许免费对话',
        domain: 'billing',
        editability: 'hot' as const,
        risk: true,
        baseline: false,
        override: true,
        effective: true,
        reason: 'incident',
        revision: 3,
      },
      {
        key: 'quota:daily',
        kind: 'quota' as const,
        name: '每日配额',
        description: '每日可用额度',
        domain: 'quota',
        editability: 'hot' as const,
        baseline: 10,
        override: 20,
        effective: 20,
        reason: 'capacity',
        revision: 3,
        unit: 'count' as const,
        baselineChanged: true,
        invalid: false,
      },
      {
        key: 'accounts:login',
        kind: 'capability' as const,
        name: '登录',
        description: '启动期登录配置',
        domain: 'accounts',
        editability: 'boot-time' as const,
        baseline: true,
        override: null,
        effective: true,
        reason: null,
        revision: 3,
      },
    ],
  }
  return {
    data,
    save: vi.fn(async () => data),
    clear: vi.fn(async () => data),
    refetch: vi.fn(async () => ({ data })),
    setQueryData: vi.fn(),
  }
})

vi.mock('../../components/Page', () => ({
  Page: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PendingState: ({ label }: { label: string }) => <div>{label}</div>,
  ErrorState: ({ label }: { label: string }) => <div>{label}</div>,
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: state.setQueryData,
    cancelQueries: vi.fn(async () => {}),
  }),
}))
vi.mock('../../lib/queries', () => ({
  operatorSettingsQueryKey: ['operator-settings'],
  useOperatorSettings: () => ({
    data: state.data,
    isPending: false,
    isError: false,
    refetch: state.refetch,
  }),
  saveOperatorSetting: state.save,
  clearOperatorSetting: state.clear,
}))

import { OperatorSettingsPage } from '../../routes/_authed.operator-settings'

describe('operator settings page', () => {
  it('rejects another quota unit and preserves an exact integer quota', async () => {
    render(<OperatorSettingsPage />)
    const row = screen.getByText('每日配额').closest('tr')!
    const input = within(row).getByRole('textbox', { name: '每日配额值' })
    fireEvent.change(input, { target: { value: '2 GB' } })
    expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'daily quota' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith('quota:daily', {
        value: 25,
        reason: 'daily quota',
        expectedRevision: 3,
      }),
    )
  })

  it('does not expose raw transport errors', async () => {
    state.save.mockRejectedValueOnce(new Error('private token and upstream URL'))
    render(<OperatorSettingsPage />)
    const row = screen.getByText('CLI API').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('操作失败，请稍后重试'))
    expect(screen.queryByText('private token and upstream URL')).not.toBeInTheDocument()
  })

  beforeEach(() => {
    state.save.mockClear()
    state.clear.mockClear()
    state.refetch.mockClear()
    state.setQueryData.mockClear()
  })

  it('renders grouped rows, read-only state, baseline and invalid distinctions, and searches', () => {
    render(<OperatorSettingsPage />)
    expect(screen.getByRole('heading', { name: '命令行' })).toBeInTheDocument()
    expect(screen.getByText('只读（需发布修改）')).toBeInTheDocument()
    expect(screen.getByText('基线已变（覆盖仍生效）')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索能力与配额'), { target: { value: '每日配额' } })
    expect(screen.getByText('每日配额')).toBeInTheDocument()
    expect(screen.queryByText('CLI API')).not.toBeInTheDocument()
  })

  it('requires a reason before saving and uses a separate cost confirmation', async () => {
    render(<OperatorSettingsPage />)
    const row = screen.getByText('免费对话').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    expect(screen.getByRole('dialog', { name: '保存覆盖' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('dialog', { name: '保存覆盖' })).getByRole('button', {
        name: '继续',
      }),
    ).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'raise budget' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(screen.getByRole('dialog', { name: '确认成本与流量影响' })).toBeInTheDocument()
    expect(state.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }))
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith(
        'billing:chat-free',
        expect.objectContaining({ reason: 'raise budget', expectedRevision: 3 }),
      ),
    )
  })

  it('requires a reason and cost confirmation when clearing a risky override', async () => {
    render(<OperatorSettingsPage />)
    const row = screen.getByText('免费对话').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '清除覆盖' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'end incident' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(screen.getByRole('dialog', { name: '确认成本与流量影响' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认清除' }))
    await waitFor(() =>
      expect(state.clear).toHaveBeenCalledWith('billing:chat-free', {
        reason: 'end incident',
        expectedRevision: 3,
      }),
    )
  })

  it('disables controls while a write is pending', async () => {
    let resolve!: (value: typeof state.data) => void
    const promise = new Promise<typeof state.data>((done) => {
      resolve = done
    })
    state.save.mockImplementationOnce(() => promise)
    render(<OperatorSettingsPage />)
    const row = screen.getByText('CLI API').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled())
    const other = screen.getByText('每日配额').closest('tr')!
    expect(within(other).getByRole('button', { name: '保存' })).toBeDisabled()
    resolve(state.data)
  })

  it('offers actionable refresh for a stale revision', async () => {
    render(<OperatorSettingsPage />)
    state.save.mockRejectedValueOnce(new ApiError(409, { error: 'stale_revision' }))
    const row = screen.getByText('CLI API').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('配置已被其他操作更新'))
    expect(screen.getByRole('button', { name: '刷新配置' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新配置' }))
    await waitFor(() => expect(state.refetch).toHaveBeenCalled())
  })
})
