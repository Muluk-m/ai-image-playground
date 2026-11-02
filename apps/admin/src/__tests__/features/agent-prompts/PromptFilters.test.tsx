// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PromptFilters } from '../../../features/agent-prompts/PromptFilters'

const window = { from: Date.UTC(2026, 9, 17, 6, 0), to: Date.UTC(2026, 9, 17, 6, 2) }

describe('PromptFilters', () => {
  it('clears the task filter that a task detail link carried in', () => {
    const onClearTask = vi.fn()
    render(
      <PromptFilters
        filters={{ ...window, taskId: 'task-1' }}
        onApply={vi.fn()}
        onClearTask={onClearTask}
      />,
    )
    expect(screen.getByText('task-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除任务筛选' }))
    expect(onClearTask).toHaveBeenCalledOnce()
  })

  it('shows no task filter when none is set', () => {
    render(<PromptFilters filters={window} onApply={vi.fn()} onClearTask={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '清除任务筛选' })).toBeNull()
  })
})
