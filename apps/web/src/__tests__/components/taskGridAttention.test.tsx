// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { markHistoryReady } from '../../lib/historyReady'
import { readLegacyProductJobs, readLegacyStoryboardTitles } from '../../lib/legacyProductHistory'
import {
  dismissSubmittedTasks,
  noteUserSubmittedTasks,
  submittedTaskSnapshot,
} from '../../lib/submittedTaskAttention'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

vi.mock('../../lib/legacyProductHistory', async (original) => ({
  ...(await original<object>()),
  readLegacyProductJobs: vi.fn(async () => []),
  readLegacyStoryboardTitles: vi.fn(async () => new Map()),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function task(id: string, createdAt: number, status: TaskRecord['status'] = 'running'): TaskRecord {
  return {
    id,
    prompt: `prompt ${id}`,
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [],
    status,
    error: null,
    createdAt,
    finishedAt: null,
    elapsed: null,
  }
}

let host: HTMLDivElement
let root: Root
let rectMode: 'inside' | 'outside'
let reducedMotion: boolean
const scrollIntoView = vi.fn()

function card(id: string): HTMLElement {
  const node = host.querySelector(`[data-task-id="${id}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`missing card ${id}`)
  return node
}

function liveText(): string {
  return host.querySelector('[aria-live="polite"]')?.textContent ?? ''
}

beforeEach(() => {
  markHistoryReady()
  rectMode = 'inside'
  reducedMotion = false
  scrollIntoView.mockClear()
  dismissSubmittedTasks([...submittedTaskSnapshot()])
  window.innerWidth = 1200
  window.innerHeight = 800
  window.matchMedia = ((query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.classList.contains('task-card-wrapper')) return new DOMRect(0, 0, 0, 0)
    return rectMode === 'outside' ? new DOMRect(0, 900, 280, 160) : new DOMRect(24, 24, 280, 160)
  })
  Element.prototype.scrollIntoView = scrollIntoView
  useStore.setState({
    tasks: [task('older', 1, 'done')],
    platformGenerations: [],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
  })
  vi.mocked(readLegacyProductJobs).mockResolvedValue([])
  vi.mocked(readLegacyStoryboardTitles).mockResolvedValue(new Map())
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  dismissSubmittedTasks([...submittedTaskSnapshot()])
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function showGrid() {
  await act(async () => root.render(<TaskGrid hero />))
}

describe('attention for a user-submitted work card', () => {
  it('does not scroll or highlight tasks that were already on the page', async () => {
    await showGrid()

    expect(host.querySelector('.task-submitted-attention')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(liveText()).toBe('')
    expect(document.activeElement).not.toBe(card('older'))
  })

  it('highlights and focuses a visible new card without scrolling', async () => {
    await showGrid()
    scrollIntoView.mockClear()

    await act(async () => {
      useStore.setState({ tasks: [task('fresh', 10), task('older', 1, 'done')] })
      noteUserSubmittedTasks(['fresh'])
    })

    const fresh = card('fresh')
    expect(fresh.className).toContain('task-submitted-attention')
    expect(fresh.tabIndex).toBe(-1)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(fresh)
    expect(liveText()).toBe('已提交')
    expect(card('older').className).not.toContain('task-submitted-attention')
  })

  it('scrolls an off-screen card into view, instantly when motion is reduced', async () => {
    rectMode = 'outside'
    reducedMotion = true
    await showGrid()
    scrollIntoView.mockClear()

    await act(async () => {
      useStore.setState({ tasks: [task('fresh', 10), task('older', 1, 'done')] })
      noteUserSubmittedTasks(['fresh'])
    })

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    })
    expect(document.activeElement).toBe(card('fresh'))
    expect(card('fresh').className).toContain('task-submitted-attention')
  })

  it('uses a smooth scroll when the user has not asked for reduced motion', async () => {
    rectMode = 'outside'
    await showGrid()
    scrollIntoView.mockClear()

    await act(async () => {
      useStore.setState({ tasks: [task('fresh', 10), task('older', 1, 'done')] })
      noteUserSubmittedTasks(['fresh'])
    })

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })
  })

  it('does not repeat the reveal when a running task is polled or an older page arrives', async () => {
    await showGrid()
    await act(async () => {
      useStore.setState({ tasks: [task('fresh', 10), task('older', 1, 'done')] })
      noteUserSubmittedTasks(['fresh'])
    })
    scrollIntoView.mockClear()
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    await act(async () => {
      useStore.setState({
        tasks: [
          { ...task('fresh', 10), queuePhase: 'generating' },
          task('older', 1, 'done'),
          task('page-2', 0, 'done'),
        ],
      })
    })

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(card('fresh').className).toContain('task-submitted-attention')
    expect(card('page-2').className).not.toContain('task-submitted-attention')
    expect(host.querySelectorAll('.task-card-wrapper')).toHaveLength(3)
  })

  it('highlights every card from one send and focuses the first', async () => {
    await showGrid()

    await act(async () => {
      useStore.setState({
        tasks: [task('first', 30), task('second', 20), task('older', 1, 'done')],
      })
      noteUserSubmittedTasks(['first', 'second'])
    })

    expect(card('first').className).toContain('task-submitted-attention')
    expect(card('second').className).toContain('task-submitted-attention')
    expect(document.activeElement).toBe(card('first'))
    expect(liveText()).toBe('已提交')
  })

  it('drops the highlight when the attention window ends', async () => {
    vi.useFakeTimers()
    await showGrid()
    await act(async () => {
      useStore.setState({ tasks: [task('fresh', 10), task('older', 1, 'done')] })
      noteUserSubmittedTasks(['fresh'])
    })
    expect(card('fresh').className).toContain('task-submitted-attention')

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(card('fresh').className).not.toContain('task-submitted-attention')
    expect(card('fresh').hasAttribute('tabindex')).toBe(false)
  })
})
