import { describe, expect, test } from 'bun:test'
import { accountQueuePositions } from '../../lib/account-concurrency'

describe('accountQueuePositions（BUG-17）', () => {
  test('套餐只能同时出 1 张：在生成的那张和更早提交的都算在前面', () => {
    const positions = accountQueuePositions(
      ['b2', 'a2'],
      [
        { id: 'a1', status: 'in_progress', submittedAt: 100 },
        { id: 'a2', status: 'queued', submittedAt: 110 },
        { id: 'b1', status: 'queued', submittedAt: 120 },
        { id: 'b2', status: 'queued', submittedAt: 130 },
      ],
      1,
    )
    expect(positions.get('a2')).toEqual({ ahead: 1, limit: 1 })
    expect(positions.get('b2')).toEqual({ ahead: 3, limit: 1 })
    expect(positions.has('b1')).toBe(false)
  })

  test('同一刻提交的按 id 排，和调度挑任务的先后一致', () => {
    const positions = accountQueuePositions(
      ['y', 'x'],
      [
        { id: 'y', status: 'queued', submittedAt: 100 },
        { id: 'x', status: 'queued', submittedAt: 100 },
      ],
      3,
    )
    expect(positions.get('x')).toEqual({ ahead: 0, limit: 3 })
    expect(positions.get('y')).toEqual({ ahead: 1, limit: 3 })
  })

  test('已经不在排队的不给位置', () => {
    const positions = accountQueuePositions(
      ['gone'],
      [{ id: 'a', status: 'in_progress', submittedAt: 1 }],
      1,
    )
    expect(positions.size).toBe(0)
  })
})
