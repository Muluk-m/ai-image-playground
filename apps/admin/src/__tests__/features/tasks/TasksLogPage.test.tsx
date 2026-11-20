// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    // First 3 columns are sticky left with deterministic left offsets
    expect(headers[0]).toHaveStyle({ left: '0px' })
    expect(headers[1]).toHaveStyle({ left: '104px' })
    expect(headers[2]).toHaveStyle({ left: '248px' })
    expect(headers[3]?.style.left).toBe('')
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
  })
})
