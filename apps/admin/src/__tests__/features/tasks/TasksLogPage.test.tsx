// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GenerationTaskItem,
  GenerationTasksFacets,
  GenerationTasksSummary,
} from '../../../../contracts'
import { TasksFilterPanel } from '../../../features/tasks/TasksFilterPanel'
import { TasksLogTable } from '../../../features/tasks/TasksLogTable'

afterEach(() => {
  cleanup()
})

const SAMPLE_TASKS: GenerationTaskItem[] = [
  {
    id: '5fc069d6-7a41-48f2-b1c9-2c7e2b9104a1',
    source: 'manual',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    status: 'in_progress',
    submitted_at: Date.parse('2026-11-20T11:06:16+08:00'),
    started_at: Date.parse('2026-11-20T11:06:17+08:00'),
    completed_at: null,
    error_type: null,
    upstream_status: null,
    gpt_route: 'direct',
    gpt_key_fingerprint: '0cc5815e',
    prompt: '把四个圈的文字都去掉，其它不变',
    upstream_invocation_count: 1,
    attempt_count: 1,
    user_id: 'usr-1',
    device_id: 'dev-1',
    username: '1745408123@qq.com',
  },
  {
    id: 'a44f18c9-2d08-4e77-b731-6e21c009ab44',
    source: 'chat',
    provider: 'openai-compat',
    model: 'gpt-image-1.5',
    status: 'failed',
    submitted_at: Date.parse('2026-11-20T11:03:51+08:00'),
    started_at: Date.parse('2026-11-20T11:04:04+08:00'),
    completed_at: Date.parse('2026-11-20T11:05:22+08:00'),
    error_type: 'upstream_timeout',
    upstream_status: 504,
    gpt_route: 'sub2api',
    gpt_key_fingerprint: null,
    prompt: '赛博朋克风格雨夜咖啡馆招牌',
    upstream_invocation_count: 4,
    attempt_count: 3,
    user_id: null,
    device_id: 'dev-anon-9',
    username: null,
  },
]

const SAMPLE_SUMMARY: GenerationTasksSummary = {
  total: 2,
  completed: 0,
  failed: 1,
  in_progress: 1,
  queued: 0,
  reconciling: 0,
  cancelled: 0,
  p50_run_ms: 15_000,
  p95_run_ms: 42_000,
}

const SAMPLE_FACETS: GenerationTasksFacets = {
  statusCounts: {
    in_progress: 1,
    queued: 0,
    reconciling: 0,
    completed: 0,
    failed: 1,
    cancelled: 0,
  },
  models: [
    { value: 'gpt-image-2.5-flare', count: 1 },
    { value: 'gpt-image-1.5', count: 1 },
  ],
  providers: [{ value: 'openai-compat', count: 2 }],
  errorTypes: [{ value: 'upstream_timeout', count: 1 }],
}

describe('TasksLogTable', () => {
  it('renders single-line cells with sticky left columns and triggers sort and row inspection', () => {
    const onSortChange = vi.fn()
    const onOpenTask = vi.fn()
    const onQuickFilterUser = vi.fn()

    render(
      <TasksLogTable
        tasks={SAMPLE_TASKS}
        summary={SAMPLE_SUMMARY}
        total={2}
        sortField="submitted_at"
        sortDir="desc"
        pinCount={3}
        hiddenCols={[]}
        density="compact"
        onSortChange={onSortChange}
        onPinCountChange={vi.fn()}
        onToggleColumn={vi.fn()}
        onResetColumns={vi.fn()}
        onDensityChange={vi.fn()}
        onOpenTask={onOpenTask}
        onQuickFilterUser={onQuickFilterUser}
        onQuickFilterDevice={vi.fn()}
      />,
    )

    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    // First 3 columns are sticky left, followed immediately by 执行耗时 and 排队等待
    expect(headers[0]).toHaveStyle({ left: '0px' })
    expect(headers[1]).toHaveStyle({ left: '104px' })
    expect(headers[2]).toHaveStyle({ left: '248px' })
    expect(headers[3]?.style.left).toBe('')
    expect(headers[3]).toHaveTextContent('执行耗时')
    expect(headers[4]).toHaveTextContent('排队等待')
    for (const header of headers) {
      expect(header.className).toContain('whitespace-nowrap')
    }

    // Clicking sortable column header triggers sort
    fireEvent.click(within(table).getByRole('button', { name: '执行耗时' }))
    expect(onSortChange).toHaveBeenCalledWith('run_ms', 'desc')

    // Clicking a cell opens the inspector drawer
    fireEvent.click(within(table).getByText('gpt-image-2.5-flare'))
    expect(onOpenTask).toHaveBeenCalledWith(SAMPLE_TASKS[0]!.id)

    // Quick-filter button on user cell filters by userId without opening drawer
    onOpenTask.mockClear()
    fireEvent.click(
      within(table).getByRole('button', { name: '仅看用户 1745408123@qq.com 的任务' }),
    )
    expect(onQuickFilterUser).toHaveBeenCalledWith('usr-1')
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('shows live elapsed run and queue durations for in-flight tasks and updates every second', () => {
    vi.useFakeTimers()
    try {
      const base = Date.parse('2026-11-23T23:28:00+08:00')
      vi.setSystemTime(base + 45_000)

      const inFlightTasks: GenerationTaskItem[] = [
        {
          ...SAMPLE_TASKS[0]!,
          id: 'queued-task-1',
          status: 'queued',
          submitted_at: base,
          started_at: null,
          completed_at: null,
        },
        {
          ...SAMPLE_TASKS[0]!,
          id: 'running-task-1',
          status: 'in_progress',
          submitted_at: base - 10_000,
          started_at: base - 5_000,
          completed_at: null,
        },
      ]

      render(
        <TasksLogTable
          tasks={inFlightTasks}
          summary={SAMPLE_SUMMARY}
          total={2}
          sortField="submitted_at"
          sortDir="desc"
          pinCount={3}
          hiddenCols={[]}
          density="compact"
          onSortChange={vi.fn()}
          onPinCountChange={vi.fn()}
          onToggleColumn={vi.fn()}
          onResetColumns={vi.fn()}
          onDensityChange={vi.fn()}
          onOpenTask={vi.fn()}
          onQuickFilterUser={vi.fn()}
          onQuickFilterDevice={vi.fn()}
        />,
      )

      const table = screen.getByRole('table')
      const rows = within(table).getAllByRole('row')
      const queuedCells = within(rows[1]!).getAllByRole('cell')
      const runningCells = within(rows[2]!).getAllByRole('cell')

      // Queued task: run_ms is '—', queue_ms shows live 45s wait
      expect(queuedCells[3]).toHaveTextContent('—')
      expect(queuedCells[4]).toHaveTextContent('45s')

      // Running task: run_ms shows live 50s execution, queue_ms shows 5.0s
      expect(runningCells[3]).toHaveTextContent('50s')
      expect(runningCells[4]).toHaveTextContent('5.0s')

      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(queuedCells[4]).toHaveTextContent('48s')
      expect(runningCells[3]).toHaveTextContent('53s')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TasksFilterPanel', () => {
  it('supports multi-status pills, source toggles, duration presets, and chip removal', () => {
    const onUpdate = vi.fn()
    const onReplace = vi.fn()
    const onPreset = vi.fn()

    render(
      <TasksFilterPanel
        search={{ statuses: ['failed'], retried: '1' }}
        preset="today"
        window={{
          from: Date.parse('2026-11-20T00:00:00+08:00'),
          to: Date.parse('2026-11-20T11:07:00+08:00'),
        }}
        facets={SAMPLE_FACETS}
        advancedOpen
        onToggleAdvanced={vi.fn()}
        onUpdate={onUpdate}
        onReplace={onReplace}
        onPreset={onPreset}
      />,
    )

    // Multi-select an additional status directly from status bar
    fireEvent.click(screen.getByRole('button', { name: /待核查/ }))
    expect(onUpdate).toHaveBeenCalledWith({
      status: undefined,
      statuses: ['failed', 'reconciling'],
    })

    // Toggle source directly
    fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
    expect(onUpdate).toHaveBeenCalledWith({
      source: undefined,
      sources: ['cli'],
    })

    // Click duration quick preset
    fireEvent.click(screen.getByRole('button', { name: '≥30s' }))
    expect(onUpdate).toHaveBeenCalledWith({
      minDurationSec: 30,
      maxDurationSec: undefined,
    })

    // Remove active chip
    fireEvent.click(screen.getByRole('button', { name: '移除特征' }))
    expect(onUpdate).toHaveBeenCalledWith({ retried: undefined })

    // Reset all active filters
    fireEvent.click(screen.getByRole('button', { name: '重置全部' }))
    expect(onReplace).toHaveBeenCalledWith({ pageSize: undefined })

    // Submitting a strict UUID task ID jumps straight to the task detail drawer as well as filtering
    const uuid = '5fc069d6-7a41-48f2-b1c9-2c7e2b9104a1'
    const searchInput = screen.getByRole('textbox', {
      name: '搜索任务 ID、提示词、用户名、指纹或模型',
    })
    fireEvent.change(searchInput, { target: { value: uuid } })
    fireEvent.submit(searchInput.closest('form')!)
    expect(onUpdate).toHaveBeenCalledWith({ q: uuid, task: uuid })

    // Plain 16-digit hex/numeric search terms should only filter, not open a nonexistent task drawer
    onUpdate.mockClear()
    fireEvent.change(searchInput, { target: { value: '1234567890123456' } })
    fireEvent.submit(searchInput.closest('form')!)
    expect(onUpdate).toHaveBeenCalledWith({ q: '1234567890123456' })
  })
})
