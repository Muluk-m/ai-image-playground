// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GenerationHistory from '../../../../components/GenerationHistory'
import HomeInspirationSection, {
  HOME_INSPIRATION_LIMIT,
} from '../../../../features/inspiration/components/HomeInspirationSection'
import { inspirationFeedOrder } from '../../../../features/inspiration/lib/seededShuffle'
import { useInspirationStore } from '../../../../features/inspiration/store'
import type { InspirationItem } from '../../../../features/inspiration/types'
import { markHistoryReady } from '../../../../lib/historyReady'
import { useStore } from '../../../../store'

const seeds = vi.hoisted(() => ({ next: 1 }))

vi.mock('../../../../features/inspiration/lib/seededShuffle', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../features/inspiration/lib/seededShuffle')
  >('../../../../features/inspiration/lib/seededShuffle')
  return { ...actual, createSeed: () => seeds.next }
})

vi.mock('../../../../lib/legacyProductHistory', () => ({
  readLegacyProductJobs: vi.fn(async () => []),
  readLegacyStoryboardTitles: vi.fn(async () => new Map()),
  legacyActionLabels: () => [],
}))

function makeItem(id: string, category = '摄影与写实'): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: `标题 ${id}`,
    prompt: 'prompt',
    thumbnailUrl: `https://example.com/${id}.jpg`,
    thumbWidth: 100,
    thumbHeight: 160,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    category,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  seeds.next = 1
  window.scrollTo = () => {}
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
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.startsWith(label),
  )

async function render(items: InspirationItem[]) {
  useInspirationStore.setState({ items, status: 'ready' })
  await act(async () => root.render(<HomeInspirationSection />))
}

it('shows two rows of fixed 4:5 cards in the seeded order with the total on 全部', async () => {
  const items = Array.from({ length: 20 }, (_, index) => makeItem(`item-${index}`))
  await render(items)
  const order = inspirationFeedOrder(items, 1)
  expect(ids()).toEqual(order.slice(0, HOME_INSPIRATION_LIMIT).map((item) => item.id))
  expect(host.textContent).toContain('灵感探索')
  expect(button('全部')?.textContent).toBe('全部20')
  expect(button('全部')?.getAttribute('aria-pressed')).toBe('true')
  const image = host.querySelector<HTMLElement>('[data-inspiration-id] .bg-muted')
  expect(image?.style.aspectRatio).toBe('4 / 5')
})

it('filters by group inside the section and only lists groups that have cases', async () => {
  const items = [
    makeItem('photo-1'),
    makeItem('poster-1', '海报与字体'),
    makeItem('poster-2', '海报与字体'),
  ]
  await render(items)
  expect(button('产品与电商')).toBeUndefined()
  await act(async () => button('海报与字体')?.click())
  expect(button('海报与字体')?.getAttribute('aria-pressed')).toBe('true')
  expect(new Set(ids())).toEqual(new Set(['poster-1', 'poster-2']))
  // 本区的分组不改灵感页的筛选。
  expect(useInspirationStore.getState().selectedGroup).toBeNull()
  await act(async () => button('全部')?.click())
  expect(ids()).toHaveLength(3)
})

it('opens a card on the explore page, and 查看全部 only goes to explore', async () => {
  const items = [makeItem('open-me'), makeItem('other')]
  await render(items)
  const first = inspirationFeedOrder(items, 1)[0]?.id
  const opener = host.querySelector<HTMLButtonElement>(`[data-inspiration-id="${first}"] button`)
  await act(async () => opener?.click())
  expect(useStore.getState().appMode).toBe('explore')
  expect(useInspirationStore.getState().detailItemId).toBe(first)

  useStore.setState({ appMode: 'image' })
  useInspirationStore.setState({ detailItemId: null, detailFallback: null })
  await act(async () => button('查看全部')?.click())
  expect(useStore.getState().appMode).toBe('explore')
  expect(useInspirationStore.getState().detailItemId).toBeNull()
})

it('shows a skeleton while loading, an empty state for an empty list, and the offline seed on error', async () => {
  useInspirationStore.setState({ items: [], status: 'loading-remote' })
  await act(async () => root.render(<HomeInspirationSection />))
  expect(host.querySelector('[data-testid="inspiration-loading"]')).not.toBeNull()

  useInspirationStore.setState({ status: 'ready', items: [] })
  await act(async () => root.render(<HomeInspirationSection />))
  expect(host.textContent).toContain('没有符合条件的灵感')
  expect(host.querySelector('[data-testid="home-inspiration-grid"]')).toBeNull()

  await act(async () => root.unmount())
  useInspirationStore.setState({ status: 'error', items: [] })
  root = createRoot(host)
  await act(async () => root.render(<HomeInspirationSection />))
  expect(host.querySelector('[data-testid="home-inspiration-grid"]')).not.toBeNull()
})

it('home works preview renders nothing until there are works', async () => {
  markHistoryReady()
  await act(async () => root.render(<GenerationHistory hero />))
  expect(host.textContent).not.toContain('我的作品')
  expect(host.querySelector('[data-task-grid-root]')).toBeNull()
})
