import { expect, it } from 'vitest'
import {
  batchGroupStartsOpen,
  batchItemStatus,
  focusedBatchItemStatusChange,
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

it('restores only the focused row when several open rows change status together', () => {
  const items = [
    { key: 'item-0', progress: 'completed' },
    { key: 'item-1', progress: 'completed' },
    { key: 'item-2', progress: 'ready' },
  ]
  const previous = new Map([
    ['item-0', 'in_flight'],
    ['item-1', 'in_flight'],
    ['item-2', 'ready'],
  ])
  expect(focusedBatchItemStatusChange(items, previous, 'item-0')).toBe('item-0')
  expect(focusedBatchItemStatusChange(items, previous, 'item-1')).toBe('item-1')
  expect(focusedBatchItemStatusChange(items, previous, null)).toBeNull()
  expect(focusedBatchItemStatusChange(items, previous, 'item-2')).toBeNull()
  expect(focusedBatchItemStatusChange(items, previous, 'missing')).toBeNull()
})
