// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { markHistoryReady } from '../../../../lib/historyReady'

const cloud = vi.hoisted(() => ({
  loading: false,
  failed: false,
  hasMore: true,
  snapshot: null,
  loadMore: vi.fn(),
  reload: vi.fn(),
}))
vi.mock('../../../../hooks/useCloudGenerations', () => ({ useCloudGenerations: () => cloud }))
vi.mock('../../../../auth/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../../../../hooks/useImagePreview', () => ({ useImagePreview: () => null }))

import WorksTab from '../../../../features/library/components/WorksTab'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TOTAL = 1000
const SIZES = ['1024x1024', '1024x1536', '1536x1024', '1024x1792']
// 视口 1440×900：五列。
const WIDTH = 1200

function task(index: number): TaskRecord {
  return {
    id: `task-${index}`,
    prompt: `p${index}`,
    params: { ...DEFAULT_PARAMS, size: SIZES[index % SIZES.length]! },
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
let observers: { callback: IntersectionObserverCallback; nodes: Element[] }[]

beforeEach(() => {
  markHistoryReady()
  cloud.loadMore.mockReset()
  cloud.hasMore = true
  cloud.loading = false
  observers = []
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      nodes: Element[] = []
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, nodes: this.nodes })
      }
      observe(node: Element) {
        this.nodes.push(node)
      }
      disconnect() {
        this.nodes.length = 0
      }
    },
  )
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: WIDTH })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  // 网格贴在页面顶上：滚下去它的 top 就是负的滚动距离。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top: -window.scrollY,
        left: 0,
        width: WIDTH,
        height: 0,
        right: WIDTH,
        bottom: -window.scrollY,
        x: 0,
        y: -window.scrollY,
      }) as DOMRect,
  )
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  useStore.setState({
    tasks: Array.from({ length: TOTAL }, (_, index) => task(index)),
    platformGenerations: [],
    selectedTaskIds: [],
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="work-card"]')]
const box = (card: HTMLElement) => {
  const top = Number(/translateY\((-?[\d.]+)px\)/.exec(card.style.transform)?.[1])
  return {
    left: Number.parseFloat(card.style.left),
    top,
    bottom: top + Number.parseFloat(card.style.height),
  }
}

it('一千张作品只挂视口附近的卡，按时间倒序从第一张开始', async () => {
  await act(async () => root.render(<WorksTab search="" />))
  const mounted = cards()
  expect(mounted.length).toBeGreaterThan(10)
  expect(mounted.length).toBeLessThanOrEqual(80)
  expect(mounted[0]?.dataset.taskId).toBe('task-0')
  expect(host.querySelector('[data-task-id="task-999"]')).toBeNull()
})

it('瀑布流：五列，每张卡进当前最矮的一列，同列之间不重叠', async () => {
  await act(async () => root.render(<WorksTab search="" />))
  const boxes = cards().map(box)
  const lanes = new Map<number, typeof boxes>()
  for (const one of boxes) lanes.set(one.left, [...(lanes.get(one.left) ?? []), one])
  expect(lanes.size).toBe(5)
  for (const lane of lanes.values()) {
    const sorted = [...lane].sort((a, b) => a.top - b.top)
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.top).toBeGreaterThanOrEqual(sorted[index - 1]!.bottom)
    }
  }
  // 第六张不在第一列下面，而在头五张里最矮那张的下面。
  const firstRow = boxes.slice(0, 5)
  const shortest = firstRow.reduce((low, one) => (one.bottom < low.bottom ? one : low))
  expect(boxes[5]!.left).toBe(shortest.left)
})

it('框选按布局算：没挂载的卡也能选中，滚过去仍是选中状态', async () => {
  await act(async () => root.render(<WorksTab search="" />))
  const mounted = new Set(cards().map((card) => card.dataset.taskId))
  const surface = host.querySelector<HTMLElement>('[data-drag-select-surface]')!
  await act(async () => {
    surface.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }),
    )
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: WIDTH - 1, clientY: 4000 }),
    )
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  const selected = useStore.getState().selectedTaskIds
  const offscreen = selected.filter((id) => !mounted.has(id))
  expect(offscreen.length).toBeGreaterThan(0)
  expect(selected).not.toContain('task-999')

  const target = offscreen[offscreen.length - 1]!
  await act(async () => {
    window.scrollY = 3200
    window.dispatchEvent(new Event('scroll'))
  })
  const card = host.querySelector<HTMLElement>(`[data-task-id="${target}"]`)
  expect(card).not.toBeNull()
  expect(card?.getAttribute('aria-pressed')).toBe('true')
})

it('滚到离底部 240px 内读下一页，读的时候不重复触发', async () => {
  await act(async () => root.render(<WorksTab search="" />))
  const sentinel = observers.find((one) => one.nodes.length > 0)
  expect(sentinel).toBeDefined()
  await act(async () => {
    sentinel!.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  })
  expect(cloud.loadMore).toHaveBeenCalledTimes(1)

  cloud.loading = true
  observers = []
  await act(async () => root.render(<WorksTab search=" " />))
  expect(observers.some((one) => one.nodes.length > 0)).toBe(false)
})

it('筛选「对话产出」时只数服务端记录，本机任务不进来', async () => {
  await act(async () => root.render(<WorksTab search="" />))
  const agentTab = [...host.querySelectorAll<HTMLElement>('[role="tab"], button')].find((one) =>
    /^(对话产出|Chat|Agent)/.test(one.textContent ?? ''),
  )
  expect(agentTab).toBeDefined()
  await act(async () => agentTab!.click())
  expect(cards()).toHaveLength(0)
})

it('键盘：卡片自身回车打开详情，卡里按钮的回车留给按钮自己', async () => {
  useStore.setState({ detailTaskId: null })
  await act(async () => root.render(<WorksTab search="" />))
  const card = cards()[0]!
  const button = card.querySelector('button')!
  const fromButton = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  act(() => {
    button.dispatchEvent(fromButton)
  })
  expect(fromButton.defaultPrevented).toBe(false)
  expect(useStore.getState().detailTaskId).toBeNull()
  act(() => {
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  expect(useStore.getState().detailTaskId).toBe('task-0')
})
