import { expect, it } from 'vitest'
import {
  batchGroupStartsOpen,
  batchItemStatus,
  groupBatchItems,
} from '../../../../features/agent/lib/batchStatusGroups'

it('groups items by progress ahead of execution status, in attention order', () => {
  const groups = groupBatchItems([
    { key: 'done', progress: 'completed', execution: { status: 'completed' } },
    { key: 'wait', progress: 'ready' },
    { key: 'run', progress: 'in_flight', execution: { status: 'queued' } },
    { key: 'wait-2', progress: 'ready' },
    { key: 'legacy', execution: { status: 'failed' } },
  ])
  expect(groups.map((group) => [group.status, group.items.map((item) => item.key)])).toEqual([
    ['in_flight', ['run']],
    ['failed', ['legacy']],
    ['ready', ['wait', 'wait-2']],
    ['completed', ['done']],
  ])
  expect(batchItemStatus({})).toBe('pending')
  expect(batchItemStatus({ execution: { status: 'not-a-status' } })).toBe('pending')
})

it('keeps a live row open and collapses a long waiting pile when several states exist', () => {
  expect(batchGroupStartsOpen('in_flight', 1, 3, false)).toBe(true)
  expect(batchGroupStartsOpen('ready', 46, 3, false)).toBe(false)
  expect(batchGroupStartsOpen('completed', 9, 3, false)).toBe(false)
  expect(batchGroupStartsOpen('failed', 2, 2, false)).toBe(true)
  expect(batchGroupStartsOpen('failed', 99, 2, false)).toBe(false)
  expect(batchGroupStartsOpen('ready', 99, 1, false)).toBe(true)
  expect(batchGroupStartsOpen('ready', 40, 2, true)).toBe(true)
})
