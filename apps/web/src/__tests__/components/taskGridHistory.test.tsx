// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { useBgSwapStore } from '../../features/bgswap/store'
import { useRemixStore } from '../../features/remix/store'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function task(id: string, setId: string, status: TaskRecord['status']): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [`out-${id}`],
    status,
    error: null,
    createdAt: Number(id.slice(-1)),
    finishedAt: 9,
    elapsed: 1,
    origin: { setId, shotId: `${id}:v1` },
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({
    tasks: [task('task-1', 'job-1', 'done'), task('task-2', 'job-1', 'error')],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
  })
  useRemixStore.setState({ sets: [], loadSets: vi.fn().mockResolvedValue(undefined) })
  useBgSwapStore.setState({
    jobs: [
      {
        id: 'job-1',
        name: '折叠浴缸',
        images: [],
        preference: '',
        versionsPerImage: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    loadJobs: vi.fn().mockResolvedValue(undefined),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('folding a background swap job in the history', () => {
  it('shows one card named after the job instead of every task', () => {
    act(() => root.render(<TaskGrid />))

    const cards = document.querySelectorAll('[data-set-history-card]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('折叠浴缸')
    expect(cards[0].textContent).toContain('换背景 · 完成 1/2')
    expect(cards[0].textContent).toContain('失败 1')
    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(0)
  })

  it('lets the card open to its tasks', () => {
    act(() => root.render(<TaskGrid />))

    const toggle = document.querySelector('[data-set-history-card] button')
    if (!toggle) throw new Error('no toggle')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(document.querySelectorAll('.task-card-wrapper')).toHaveLength(2)
  })
})
