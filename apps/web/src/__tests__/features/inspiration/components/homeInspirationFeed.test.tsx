// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GenerationHistory from '../../../../components/GenerationHistory'
import InspirationEmptyHero from '../../../../features/inspiration/components/InspirationEmptyHero'
import { inspirationFeedOrder } from '../../../../features/inspiration/lib/seededShuffle'
import { useInspirationStore } from '../../../../features/inspiration/store'
import type { InspirationItem } from '../../../../features/inspiration/types'
import { markHistoryReady } from '../../../../lib/historyReady'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'

const seeds = vi.hoisted(() => ({ next: 1 }))

vi.mock('../../../../features/inspiration/lib/seededShuffle', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../features/inspiration/lib/seededShuffle')
  >('../../../../features/inspiration/lib/seededShuffle')
  return { ...actual, createSeed: () => seeds.next }
})

vi.mock('../../../../components/TaskCard', () => ({
  default: ({ task }: { task: { id: string } }) => <div data-testid="task-card">{task.id}</div>,
}))

vi.mock('../../../../lib/legacyProductHistory', () => ({
  readLegacyProductJobs: vi.fn(async () => []),
  readLegacyStoryboardTitles: vi.fn(async () => new Map()),
  legacyActionLabels: () => [],
}))

class MockObserver implements IntersectionObserver {
  static latest: MockObserver | null = null
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = []
  constructor(private readonly callback: IntersectionObserverCallback) {
    MockObserver.latest = this
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  fire() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this)
  }
}

function makeItem(id: string, thumbnailUrl = `https://example.com/${id}.jpg`): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: `标题 ${id}`,
    prompt: 'prompt',
    thumbnailUrl,
    thumbWidth: 100,
    thumbHeight: 100,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    category: '摄影与写实',
  }
}

function task(id: string): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: useStore.getState().params,
    inputImageIds: [],
    outputImages: ['out'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 1,
    elapsed: 1,
  }
}

let host: HTMLDivElement
let root: Root
let scrollY = 0
let feedWidth = 1200

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  seeds.next = 1
  scrollY = 0
  feedWidth = 1200
  MockObserver.latest = null
  vi.stubGlobal('IntersectionObserver', MockObserver)
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('1024') || query.includes('640'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  window.scrollTo = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => feedWidth)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top: -scrollY,
        left: 0,
        width: feedWidth,
        height: 280,
        right: feedWidth,
        bottom: -scrollY + 280,
        x: 0,
        y: -scrollY,
        toJSON() {},
      }) as DOMRect,
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.index !== undefined ? 280 : 0
  })
  useStore.setState({
    appMode: 'image',
    tasks: [],
    platformGenerations: [],
    pinnedInspirationIds: [],
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
  })
  useInspirationStore.setState({
    items: [],
    status: 'ready',
    detailItemId: null,
    detailFallback: null,
    loadRemote: async () => {},
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ids = () =>
  [...host.querySelectorAll<HTMLElement>('[data-inspiration-id]')].map(
    (node) => node.dataset.inspirationId,
  )

async function renderHero(items: InspirationItem[]) {
  useInspirationStore.setState({ items, status: 'ready' })
  await act(async () => root.render(<InspirationEmptyHero />))
}

it('挂载视口附近的卡片，而不是整份清单', async () => {
  const items = Array.from({ length: 80 }, (_, index) => makeItem(`card-${index}`))
  const order = inspirationFeedOrder(items, 1)
  await renderHero(items)
  const feed = host.querySelector<HTMLElement>('[data-testid="home-inspiration-feed"]')
  expect(feed?.dataset.columns).toBe('5')
  expect(feed?.dataset.loaded).toBe('30')
  const mounted = ids()
  expect(mounted.length).toBeGreaterThan(0)
  expect(mounted.length).toBeLessThan(30)
  expect(mounted).toContain(order[0]?.id)
  expect(mounted).not.toContain(order[29]?.id)
  expect(host.textContent).toContain('灵感探索')
  expect(host.textContent).toContain('查看全部')
})

it('窄容器排成两列', async () => {
  feedWidth = 390
  await renderHero([makeItem('only'), makeItem('next')])
  expect(
    host.querySelector<HTMLElement>('[data-testid="home-inspiration-feed"]')?.dataset.columns,
  ).toBe('2')
})

it('滚动只换可见卡片，顺序和已加载范围保持不变', async () => {
  const items = Array.from({ length: 40 }, (_, index) => makeItem(`card-${index}`))
  const order = inspirationFeedOrder(items, 1)
  await renderHero(items)
  expect(ids()).toContain(order[0]?.id)
  scrollY = 1500
  await act(async () => {
    window.dispatchEvent(new Event('scroll'))
  })
  const mounted = ids()
  expect(
    host.querySelector('[data-testid="home-inspiration-feed"]')?.getAttribute('data-loaded'),
  ).toBe('30')
  expect(mounted).not.toContain(order[0]?.id)
  expect(mounted.length).toBeGreaterThan(0)
  expect(new Set(mounted).size).toBe(mounted.length)
  for (const id of mounted) expect(order.slice(0, 30).map((entry) => entry.id)).toContain(id)
})

it('滚近底部再展开下一批，已经排好的卡片不重洗', async () => {
  const items = Array.from({ length: 70 }, (_, index) => makeItem(`card-${index}`))
  const order = inspirationFeedOrder(items, 1)
  await renderHero(items)
  expect(ids()).toContain(order[0]?.id)
  await act(async () => {
    MockObserver.latest?.fire()
  })
  const feed = host.querySelector<HTMLElement>('[data-testid="home-inspiration-feed"]')
  expect(feed?.dataset.loaded).toBe('60')
  expect(ids()).toContain(order[0]?.id)
  expect(ids()).not.toContain(order[69]?.id)
})

it('同一次进入顺序稳定，再次进入换种子就换顺序', async () => {
  const items = Array.from({ length: 12 }, (_, index) => makeItem(`card-${index}`))
  const first = inspirationFeedOrder(items, 1)
  const second = inspirationFeedOrder(items, 99)
  expect(first[0]?.id).not.toBe(second[0]?.id)
  await renderHero(items)
  const indexZero = () => host.querySelector<HTMLElement>('[data-index="0"]')?.dataset.inspirationId
  expect(indexZero()).toBe(first[0]?.id)
  await act(async () => {
    useInspirationStore.setState({ items: [...items].reverse() })
  })
  expect(indexZero()).toBe(first[0]?.id)
  seeds.next = 99
  useInspirationStore.setState({ items })
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(<InspirationEmptyHero />))
  expect(indexZero()).toBe(second[0]?.id)
})

it('点击卡片打开探索页上的灵感详情，查看全部只去探索页', async () => {
  const items = [makeItem('open-me'), makeItem('other')]
  await renderHero(items)
  const opener = host.querySelector<HTMLButtonElement>(
    `[data-inspiration-id="${inspirationFeedOrder(items, 1)[0]?.id}"] button`,
  )
  await act(async () => opener?.click())
  expect(useStore.getState().appMode).toBe('explore')
  expect(useInspirationStore.getState().detailItemId).toBe(inspirationFeedOrder(items, 1)[0]?.id)

  await act(async () => root.unmount())
  useStore.setState({ appMode: 'image' })
  useInspirationStore.setState({ detailItemId: null, detailFallback: null })
  root = createRoot(host)
  await renderHero(items)
  const viewAll = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('查看全部'),
  )
  await act(async () => viewAll?.click())
  expect(useStore.getState().appMode).toBe('explore')
  expect(useInspirationStore.getState().detailItemId).toBeNull()
})

it('清单还没到是骨架，空清单给空态，失败时用离线种子', async () => {
  useInspirationStore.setState({ items: [], status: 'loading-remote' })
  await act(async () => root.render(<InspirationEmptyHero />))
  expect(host.querySelector('[data-testid="inspiration-loading"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="home-inspiration-feed"]')).toBeNull()

  useInspirationStore.setState({ status: 'ready', items: [] })
  await act(async () => root.render(<InspirationEmptyHero />))
  expect(host.textContent).toContain('没有符合条件的灵感')
  expect(host.querySelector('[data-testid="home-inspiration-feed"]')).toBeNull()

  await act(async () => root.unmount())
  useInspirationStore.setState({ status: 'error', items: [] })
  root = createRoot(host)
  await act(async () => root.render(<InspirationEmptyHero />))
  expect(host.querySelector('[data-testid="home-inspiration-feed"]')).not.toBeNull()
})

it('有作品时不挂灵感瀑布，没作品时才挂', async () => {
  markHistoryReady()
  const items = [makeItem('home'), makeItem('feed')]
  useInspirationStore.setState({ items, status: 'ready' })
  useStore.setState({ tasks: [task('work-1')] })
  await act(async () => root.render(<GenerationHistory hero />))
  expect(host.querySelector('[data-testid="home-inspiration-feed"]')).toBeNull()
  expect(host.textContent).toContain('我的作品')
  expect(host.querySelector('[data-testid="task-card"]')).not.toBeNull()

  useStore.setState({ tasks: [] })
  await act(async () => root.render(<GenerationHistory hero />))
  expect(host.querySelector('[data-testid="home-inspiration-feed"]')).not.toBeNull()
  expect(host.textContent).not.toContain('我的作品')
})
