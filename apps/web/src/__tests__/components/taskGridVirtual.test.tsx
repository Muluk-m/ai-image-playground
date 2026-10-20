// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TaskGrid from '../../components/TaskGrid'
import { markHistoryReady } from '../../lib/historyReady'

const renders = vi.hoisted(() => [] as string[])
vi.mock('../../components/TaskCard', () => ({
  default: ({ task }: { task: { id: string } }) => {
    renders.push(task.id)
    return <div className="task-card">{task.id}</div>
  },
}))
vi.mock('../../lib/legacyProductHistory', async (original) => ({
  ...(await original<object>()),
  readLegacyProductJobs: vi.fn(async () => []),
  readLegacyStoryboardTitles: vi.fn(async () => new Map()),
}))

import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 与网格的行高预估一致：未挂载的行按预估参与框选。
const ROW_HEIGHT = 420
const TOTAL = 300

function task(index: number): TaskRecord {
  return {
    id: `task-${index}`,
    prompt: 'p',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: [`out-${index}`],
    status: 'done',
    error: null,
    createdAt: TOTAL - index,
    finishedAt: TOTAL - index,
    elapsed: 1,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  markHistoryReady()
  renders.length = 0
  // 桌面三列、每行 420px、视口 900px 高；jsdom 没有布局，按这个尺寸模拟。
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('1024') || query.includes('640'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.dataset.index !== undefined ? ROW_HEIGHT : 0
    return {
      top: 0,
      left: 0,
      width: 1200,
      height,
      right: 1200,
      bottom: height,
      x: 0,
      y: 0,
    } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.index !== undefined ? ROW_HEIGHT : 0
  })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  useStore.setState({
    tasks: Array.from({ length: TOTAL }, (_, index) => task(index)),
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
  })
  host = document.createElement('div')
  host.setAttribute('data-drag-select-surface', '')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mounted = () => [...host.querySelectorAll<HTMLElement>('[data-task-id]')]

it('mounts only the rows near the viewport when every work is shown', async () => {
  await act(async () => root.render(<TaskGrid />))
  const cards = mounted()
  expect(cards.length).toBeGreaterThan(0)
  expect(cards.length).toBeLessThan(40)
  expect(cards[0]?.dataset.taskId).toBe('task-0')
  expect(host.querySelector('[data-task-id="task-299"]')).toBeNull()
})

it('virtualizes the home page immediately and ignores filters from the library', async () => {
  useStore.setState({ searchQuery: 'no matching work', filterFavorite: true })
  await act(async () => root.render(<TaskGrid hero />))
  expect(mounted().length).toBeGreaterThan(0)
  expect(mounted().length).toBeLessThan(40)
  expect(mounted()[0]?.dataset.taskId).toBe('task-0')
  expect(host.querySelector('[data-task-id="task-299"]')).toBeNull()
})

it('re-renders only the card whose task changed', async () => {
  await act(async () => root.render(<TaskGrid />))
  renders.length = 0
  await act(async () =>
    useStore.setState((state) => ({
      tasks: state.tasks.map((one) => (one.id === 'task-1' ? { ...one, isFavorite: true } : one)),
    })),
  )
  expect(renders).toEqual(['task-1'])
})

it('drag-selects cards that are scrolled out and not mounted', async () => {
  await act(async () => root.render(<TaskGrid />))
  const visible = new Set(mounted().map((card) => card.dataset.taskId))
  await act(async () => {
    host.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }),
    )
    // 拖到第 7 行（每行 420 + 间距 16）：前 21 张都在框里，后几行没有挂载。
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 1199, clientY: 3000 }),
    )
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  const selected = useStore.getState().selectedTaskIds
  expect(selected).toHaveLength(21)
  expect(selected).toContain('task-20')
  expect(visible.has('task-20')).toBe(false)
  expect(selected).not.toContain('task-21')
})
