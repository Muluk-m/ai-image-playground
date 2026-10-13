// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../lib/legacyProductHistory', () => ({
  readLegacyProductJobs: vi.fn(async () => []),
  readLegacyStoryboardTitles: vi.fn(async () => new Map()),
  legacyActionLabels: () => [],
}))

import TaskGrid from '../../components/TaskGrid'
import { isHistoryReady, markHistoryReady } from '../../lib/historyReady'
import { useStore } from '../../store'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useStore.setState({
    tasks: [],
    platformGenerations: [],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('首页作品在本机记录落地前是骨架，落地后空账号回到灵感区', async () => {
  const workPulses = () =>
    [...host.querySelectorAll('[class*="aspect-[4/3]"]')].filter((node) =>
      node.className.includes('animate-pulse'),
    )
  expect(isHistoryReady()).toBe(false)
  await act(async () => root.render(<TaskGrid hero />))
  expect(workPulses()).toHaveLength(3)
  expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull()

  await act(async () => {
    markHistoryReady()
  })
  expect(isHistoryReady()).toBe(true)
  expect(workPulses()).toHaveLength(0)
})
