// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectCover, {
  PROJECT_COVER_RETRY_MS,
  PROJECT_COVER_TIMEOUT_MS,
} from '../../../../features/canvas/components/ProjectCover'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'

it('shows a spinner until the image loads, and never spins forever for an empty or failed cover', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,AQID" chat />))
    expect(host.querySelector('[role=status] .animate-spin')).not.toBeNull()
    await act(async () => host.querySelectorAll('img')[1]!.dispatchEvent(new Event('load')))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,BAUG" chat />))
    expect(host.querySelector('[role=status]')).not.toBeNull()
    await act(async () => host.querySelectorAll('img')[1]!.dispatchEvent(new Event('error')))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover chat />))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover chat pending />))
    expect(host.querySelector('[role=status] .animate-spin')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('ends loading when cloud preview resolution fails', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', async () => Response.json({ error: 'media_not_found' }, { status: 404 }))
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<ProjectCover source="aip-media:11000000-0000-4000-8000-000000000001" chat />),
    )
    await vi.waitFor(() => expect(host.querySelector('[role=status]')).toBeNull())
    expect(host.querySelectorAll('img')).toHaveLength(2)
    expect(host.querySelectorAll('img')[1]!.className).toContain('opacity-0')
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('屏幕外的封面不去取图，滚到附近才开始加载（资产页反馈）', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const observers: { callback: IntersectionObserverCallback; observed: Element[] }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observed: Element[] = []
      constructor(public callback: IntersectionObserverCallback) {
        observers.push(this)
      }
      observe(node: Element) {
        this.observed.push(node)
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    },
  )
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,AQID" chat />))
    expect(host.querySelectorAll('img')).toHaveLength(0)
    expect(host.querySelector('[role=status] .animate-spin')).not.toBeNull()
    await act(async () =>
      observers[0]!.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observers[0] as unknown as IntersectionObserver,
      ),
    )
    expect(host.querySelectorAll('img')).toHaveLength(2)
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('封面迟迟取不到就停止转圈，失败后自动重试一次，「刷新项目」再重新加载（资产页反馈）', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  const host = document.createElement('div')
  const root = createRoot(host)
  const cover = () => host.querySelectorAll('img')[1]!
  try {
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,AQID" chat />))
    expect(host.querySelector('[role=status]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(PROJECT_COVER_TIMEOUT_MS))
    expect(host.querySelector('[role=status]')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()
    // 超时后真加载到了，照样换成图片。
    await act(async () => cover().dispatchEvent(new Event('load')))
    expect(cover().getAttribute('data-project-cover-state')).toBe('loaded')

    await act(async () => root.render(<ProjectCover source="data:image/png;base64,BAUG" chat />))
    const first = cover()
    await act(async () => first.dispatchEvent(new Event('error')))
    expect(cover().getAttribute('data-project-cover-state')).toBe('failed')
    await act(async () => vi.advanceTimersByTime(PROJECT_COVER_RETRY_MS))
    expect(cover()).not.toBe(first)
    expect(cover().getAttribute('data-project-cover-state')).toBe('loading')
    const second = cover()
    await act(async () => second.dispatchEvent(new Event('error')))
    await act(async () => vi.advanceTimersByTime(PROJECT_COVER_RETRY_MS * 3))
    // 自动只重试一次，之后停在图标上。
    expect(cover()).toBe(second)
    expect(host.querySelector('[role=status]')).toBeNull()

    await act(async () =>
      useCanvasProjectStore.setState((state) => ({ coverRetryRound: state.coverRetryRound + 1 })),
    )
    expect(cover()).not.toBe(second)
    expect(cover().getAttribute('data-project-cover-state')).toBe('loading')
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
  }
})
