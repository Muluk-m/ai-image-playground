// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cardNeedsScroll,
  dismissSubmittedTasks,
  noteUserSubmittedTasks,
  prefersReducedMotion,
  revealSubmittedCard,
  SUBMITTED_TASK_HIGHLIGHT_MS,
  submittedTaskSnapshot,
  subscribeSubmittedTasks,
} from '../../lib/submittedTaskAttention'

afterEach(() => {
  vi.useRealTimers()
  dismissSubmittedTasks([...submittedTaskSnapshot()])
})

describe('submitted task attention', () => {
  it('records a user send once and drops it after the highlight window', () => {
    vi.useFakeTimers()
    const seen: string[][] = []
    const stop = subscribeSubmittedTasks(() => {
      seen.push([...submittedTaskSnapshot()])
    })

    noteUserSubmittedTasks([])
    noteUserSubmittedTasks(['task-a'])
    noteUserSubmittedTasks(['task-a', 'task-b'])

    expect(submittedTaskSnapshot()).toEqual(['task-a', 'task-b'])
    expect(seen).toEqual([['task-a'], ['task-a', 'task-b']])

    vi.advanceTimersByTime(SUBMITTED_TASK_HIGHLIGHT_MS - 1)
    expect(submittedTaskSnapshot()).toEqual(['task-a', 'task-b'])
    vi.advanceTimersByTime(1)
    expect(submittedTaskSnapshot()).toEqual([])
    stop()
  })

  it('clears a pending highlight when the id is dismissed early', () => {
    vi.useFakeTimers()
    noteUserSubmittedTasks(['task-a'])
    dismissSubmittedTasks(['task-a'])
    vi.advanceTimersByTime(SUBMITTED_TASK_HIGHLIGHT_MS)
    expect(submittedTaskSnapshot()).toEqual([])
  })

  it('scrolls only when the card is clipped, and skips motion when requested', () => {
    window.innerWidth = 800
    window.innerHeight = 600
    const element = document.createElement('div')
    element.tabIndex = -1
    document.body.appendChild(element)
    const scrollIntoView = vi.fn()
    element.scrollIntoView = scrollIntoView
    const focus = vi.spyOn(element, 'focus')

    element.getBoundingClientRect = () => new DOMRect(10, 10, 100, 80)
    expect(cardNeedsScroll(element)).toBe(false)
    revealSubmittedCard(element)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })

    element.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
    expect(cardNeedsScroll(element)).toBe(false)

    element.getBoundingClientRect = () => new DOMRect(0, 700, 120, 80)
    expect(cardNeedsScroll(element)).toBe(true)
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    expect(prefersReducedMotion()).toBe(true)
    revealSubmittedCard(element)
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    })

    element.remove()
  })
})
