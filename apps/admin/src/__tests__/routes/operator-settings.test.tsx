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
        min: 1,
        max: 100,
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
      {
        key: 'agent:visual-prepare-concurrency',
        kind: 'quota' as const,
        name: '视觉准备并发',
        description: '同时进行视觉预处理的任务数',
        domain: 'agent',
        editability: 'hot' as const,
        baseline: 5,
        override: -1,
        effective: 5,
        reason: 'corrupted',
        revision: 3,
        unit: 'count' as const,
        min: 1,
        max: 64,
        invalid: true,
        invalidReason: 'invalid_value',
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
    isFetching: false,
    refetch: state.refetch,
  }),
  saveOperatorSetting: state.save,
  clearOperatorSetting: state.clear,
}))

import {
  OperatorSettingsPanel,
  parseSettingInput,
} from '../../features/platform-settings/OperatorSettingsPanel'

function getSettingRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li')
  if (!row) throw new Error(`Missing setting row for ${name}`)
  return row
}

describe('operator settings panel', () => {
  beforeEach(() => {
    state.save.mockClear()
    state.clear.mockClear()
    state.refetch.mockClear()
    state.setQueryData.mockClear()
  })

  it('rejects another quota unit, out-of-range values, and preserves an exact integer quota', async () => {
    render(<OperatorSettingsPanel />)
    const row = getSettingRow('每日配额')
    const input = within(row).getByRole('textbox', { name: '每日配额值' })

    // Untouched quota row does not show noisy save button
    expect(within(row).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()

    // Wrong unit disables save
    fireEvent.change(input, { target: { value: '2 GB' } })
    expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled()

    // Non-integer disables save
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled()

    // Out-of-range disables save
    fireEvent.change(input, { target: { value: '200' } })
    expect(within(row).getByRole('button', { name: '保存' })).toBeDisabled()

    // Valid integer enables save and submits exact integer
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
    render(<OperatorSettingsPanel />)
    const row = getSettingRow('CLI API')
    fireEvent.click(within(row).getByRole('switch', { name: 'CLI API' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('操作失败，请稍后重试'))
    expect(screen.queryByText('private token and upstream URL')).not.toBeInTheDocument()
  })

  it('renders grouped rows, read-only state, baseline distinctions, status filters, domain filters, and search', () => {
    render(<OperatorSettingsPanel />)
    expect(screen.getByRole('heading', { name: '命令行' })).toBeInTheDocument()
    expect(screen.getByText('基线已变（覆盖仍生效）')).toBeInTheDocument()
    const loginRow = getSettingRow('登录')
    expect(within(loginRow).getByText('仅发布修改')).toBeInTheDocument()

    // Status filter: only overridden rows
    const statusGroup = screen.getByRole('group', { name: '配置状态筛选' })
    fireEvent.click(within(statusGroup).getByRole('button', { name: /已覆盖/ }))
    expect(screen.getByText('每日配额')).toBeInTheDocument()
    expect(screen.getByText('免费对话')).toBeInTheDocument()
    expect(screen.queryByText('CLI API')).not.toBeInTheDocument()
    expect(screen.queryByText('登录')).not.toBeInTheDocument()

    // Reset back to all and test domain filter
    fireEvent.click(within(statusGroup).getByRole('button', { name: /全部/ }))
    const domainGroup = screen.getByRole('group', { name: '领域筛选' })
    fireEvent.click(within(domainGroup).getByRole('button', { name: /命令行/ }))
    expect(screen.getByText('CLI API')).toBeInTheDocument()
    expect(screen.queryByText('每日配额')).not.toBeInTheDocument()

    // Reset domain filter and search
    fireEvent.click(within(domainGroup).getByRole('button', { name: /全部领域/ }))
    fireEvent.change(screen.getByLabelText('搜索能力与配额'), { target: { value: '每日配额' } })
    expect(screen.getByText('每日配额')).toBeInTheDocument()
    expect(screen.queryByText('CLI API')).not.toBeInTheDocument()
  })

  it('requires a reason before saving via Switch and uses a separate cost confirmation', async () => {
    render(<OperatorSettingsPanel />)
    const row = getSettingRow('免费对话')
    fireEvent.click(within(row).getByRole('switch', { name: '免费对话' }))
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
      expect(state.save).toHaveBeenCalledWith('billing:chat-free', {
        value: false,
        reason: 'raise budget',
        expectedRevision: 3,
      }),
    )
  })

  it('requires a reason and cost confirmation when clearing a risky override', async () => {
    render(<OperatorSettingsPanel />)
    const row = getSettingRow('免费对话')
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
    render(<OperatorSettingsPanel />)
    const row = getSettingRow('CLI API')
    fireEvent.click(within(row).getByRole('switch', { name: 'CLI API' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(within(row).getByRole('switch', { name: 'CLI API' })).toBeDisabled())
    const other = getSettingRow('每日配额')
    expect(within(other).getByRole('textbox', { name: '每日配额值' })).toBeDisabled()
    resolve(state.data)
  })

  it('offers actionable refresh for a stale revision', async () => {
    render(<OperatorSettingsPanel />)
    state.save.mockRejectedValueOnce(new ApiError(409, { error: 'stale_revision' }))
    const row = getSettingRow('CLI API')
    fireEvent.click(within(row).getByRole('switch', { name: 'CLI API' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'enable' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('配置已被其他操作更新'))
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('button', { name: '刷新配置' })).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: '刷新配置' }))
    await waitFor(() => expect(state.refetch).toHaveBeenCalled())
  })

  it('keeps clear-override accessible for invalid quota overrides and ignores IME composing Enter', async () => {
    render(<OperatorSettingsPanel />)
    const invalidRow = getSettingRow('视觉准备并发')
    expect(within(invalidRow).getByText('覆盖无效')).toBeInTheDocument()
    const input = within(invalidRow).getByRole('textbox', { name: '视觉准备并发值' })
    expect(input).toHaveValue('5 条')
    expect(within(invalidRow).getByRole('button', { name: '清除覆盖' })).toBeInTheDocument()

    // Editing triggers dirty state; IME composing Enter does NOT open dialog
    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Clearing invalid override works directly
    fireEvent.click(within(invalidRow).getByRole('button', { name: '撤销视觉准备并发修改' }))
    expect(input).toHaveValue('5 条')
    fireEvent.click(within(invalidRow).getByRole('button', { name: '清除覆盖' }))
    fireEvent.change(screen.getByRole('textbox', { name: '修改原因' }), {
      target: { value: 'cleanup invalid override' },
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() =>
      expect(state.clear).toHaveBeenCalledWith('agent:visual-prepare-concurrency', {
        reason: 'cleanup invalid override',
        expectedRevision: 3,
      }),
    )
  })

  it('parses decimal unit values without IEEE-754 precision loss', () => {
    expect(parseSettingInput('1.15 分钟', 'seconds')).toBe(69)
    expect(parseSettingInput('1.5 GB', 'bytes')).toBe(1_610_612_736)
    expect(parseSettingInput('1.5', 'count')).toBeNaN()
  })
})
