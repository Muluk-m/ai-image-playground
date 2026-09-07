// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyncStatusPanel, { syncLabel } from '../../components/SyncStatusPanel'
import { useSyncStatus } from '../../lib/sync/status'

vi.mock('../../lib/sync/engine', () => ({ syncNow: vi.fn() }))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<SyncStatusPanel />)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSyncStatus.setState({
    enabled: true,
    status: 'idle',
    pending: 0,
    lastSyncedAt: null,
    uploads: null,
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSyncStatus.setState({
    enabled: false,
    status: 'idle',
    pending: 0,
    lastSyncedAt: null,
    uploads: null,
  })
})

describe('the sync status panel', () => {
  it('stays out of the way when the engine is not running', () => {
    useSyncStatus.setState({ enabled: false })

    render()

    expect(host.textContent).toBe('')
  })

  it('offers a retry only when the last run failed', () => {
    useSyncStatus.setState({ status: 'error' })
    render()
    expect(host.textContent).toContain('同步失败')
    expect(host.querySelector('button')?.textContent).toBe('立即重试')

    act(() => {
      useSyncStatus.setState({ status: 'idle', lastSyncedAt: Date.now() })
    })
    expect(host.querySelector('button')).toBeNull()
  })

  it('shows the bulk upload progress while it runs', () => {
    useSyncStatus.setState({ status: 'syncing', uploads: { done: 1, total: 3 } })

    render()

    expect(host.textContent).toContain('上传素材图 1/3')
  })
})

describe('the status label', () => {
  const now = 1_700_000_000_000

  it('states the state and nothing else', () => {
    expect(syncLabel({ status: 'idle', pending: 2, lastSyncedAt: now, now })).toBe('2 项待同步')
    expect(syncLabel({ status: 'error', pending: 0, lastSyncedAt: now, now })).toBe('同步失败')
    expect(syncLabel({ status: 'syncing', pending: 0, lastSyncedAt: now, now })).toBe('同步中')
    expect(syncLabel({ status: 'idle', pending: 0, lastSyncedAt: null, now })).toBe('尚未同步')
  })

  it('counts the asset images a bulk upload still has to send', () => {
    expect(
      syncLabel({
        status: 'syncing',
        pending: 5,
        lastSyncedAt: null,
        uploads: { done: 2, total: 5 },
        now,
      }),
    ).toBe('上传素材图 2/5')
  })

  it('dates the last successful run', () => {
    expect(syncLabel({ status: 'idle', pending: 0, lastSyncedAt: now - 5_000, now })).toBe(
      '已同步 · 刚刚',
    )
    expect(syncLabel({ status: 'idle', pending: 0, lastSyncedAt: now - 180_000, now })).toBe(
      '已同步 · 3 分钟前',
    )
    expect(syncLabel({ status: 'idle', pending: 0, lastSyncedAt: now - 7_200_000, now })).toBe(
      '已同步 · 2 小时前',
    )
    expect(syncLabel({ status: 'idle', pending: 0, lastSyncedAt: now - 172_800_000, now })).toBe(
      '已同步 · 2 天前',
    )
  })
})
