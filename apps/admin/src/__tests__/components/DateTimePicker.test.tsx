import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DateTimePicker } from '../../components/DateTimePicker'

function renderPicker(value: string, props: { disabled?: boolean } = {}) {
  const onChange = vi.fn()
  render(<DateTimePicker aria-label="起始时间" value={value} onChange={onChange} {...props} />)
  return { onChange, user: userEvent.setup() }
}

describe('DateTimePicker', () => {
  it('shows the current value on the trigger', () => {
    renderPicker('2026-08-15T22:31')
    expect(screen.getByRole('button', { name: '起始时间' })).toHaveTextContent('2026/08/15 22:31')
  })

  it('shows a placeholder when no value is set', () => {
    renderPicker('')
    expect(screen.getByRole('button', { name: '起始时间' })).toHaveTextContent('选择日期和时间')
  })

  it('keeps the time when another day is picked', async () => {
    const { onChange, user } = renderPicker('2026-08-15T22:31')

    await user.click(screen.getByRole('button', { name: '起始时间' }))
    await user.click(screen.getByRole('button', { name: /2026年8月20日/ }))

    expect(onChange).toHaveBeenCalledWith('2026-08-20T22:31')
  })

  it('keeps the day when another hour or minute is picked', async () => {
    const { onChange, user } = renderPicker('2026-08-15T22:31')

    await user.click(screen.getByRole('button', { name: '起始时间' }))
    await user.click(screen.getByRole('button', { name: '时 09' }))
    await user.click(screen.getByRole('button', { name: '分 05' }))

    expect(onChange).toHaveBeenNthCalledWith(1, '2026-08-15T09:31')
    expect(onChange).toHaveBeenNthCalledWith(2, '2026-08-15T22:05')
  })

  it('never opens the panel while disabled', async () => {
    const { user } = renderPicker('2026-08-15T22:31', { disabled: true })

    await user.click(screen.getByRole('button', { name: '起始时间' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
