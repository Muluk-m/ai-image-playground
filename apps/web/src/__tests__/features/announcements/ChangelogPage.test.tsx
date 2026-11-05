// @vitest-environment jsdom
import type { AnnouncementPublicItem } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AnnouncementEntry,
  AnnouncementMenuRow,
} from '../../../features/announcements/AnnouncementEntry'
import ChangelogPage from '../../../features/announcements/ChangelogPage'
import { markAnnouncementFeed } from '../../../features/announcements/client'
import {
  announcementUnreadCount,
  currentAnnouncementEpoch,
  setAnnouncementFeed,
} from '../../../features/announcements/panel'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const ITEM: AnnouncementPublicItem = {
  id: 'update-1',
  type: 'feature',
  importance: 'normal',
  title: 'GPT Image 2.6 与 Agent 接入',
  body: '## GPT Image 2.6\n\n- 新增模型 2.6 Flare\n- 支持 GIF、SVG 输出\n\n1. 粗剪\n2. 字幕',
  usedFallback: false,
  coverUrl: 'https://assets.example/cover.png',
  ctaLabel: '去集成插件',
  ctaUrl: '/connect',
  versionTag: 'v0.4.331',
  publishAt: Date.UTC(2026, 8, 11, 12),
  unread: true,
  dismissed: false,
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

function json(body: unknown): Response {
  return Response.json(body)
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  setAnnouncementFeed({ items: [], unreadCount: 0 })
  localStorage.clear()
  window.history.replaceState(null, '', '/changelog')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  setAnnouncementFeed({ items: [], unreadCount: 0 })
})

async function renderPage(items: AnnouncementPublicItem[] = [ITEM]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ items, unreadCount: items.filter((item) => item.unread).length })),
  )
  await act(async () => {
    root.render(<ChangelogPage />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

it('renders a changelog entry with version, date, numbered points, media and a call to action', async () => {
  await renderPage()
  const entry = host.querySelector('[data-slot="changelog-entry"]')
  expect(entry?.textContent).toContain('v0.4.331')
  expect(entry?.textContent).toContain('2026年9月11日')
  expect(entry?.textContent).toContain('GPT Image 2.6 与 Agent 接入')
  expect(entry?.textContent).toContain('GPT Image 2.6')
  const lists = Array.from(entry?.querySelectorAll('ol') ?? []).map((list) => list.textContent)
  expect(lists[0]).toContain('新增模型 2.6 Flare')
  expect(lists[1]).toContain('粗剪')
  expect(lists).toHaveLength(2)
  expect(entry?.querySelector('[class*="lg:grid-cols-2"]')).not.toBeNull()
  const media = host.querySelector('[data-slot="changelog-media"] img')
  expect(media?.getAttribute('src')).toBe(ITEM.coverUrl)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(announcementUnreadCount()).toBe(0)

  const action = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('去集成插件'),
  )
  await act(async () => action?.click())
  expect(location.pathname).toBe('/connect')
})

it('stacks an entry that has no demo media', async () => {
  await renderPage([{ ...ITEM, id: 'plain', coverUrl: null, ctaLabel: null, ctaUrl: null }])
  const entry = host.querySelector('[data-slot="changelog-entry"]')
  expect(entry?.querySelector('[data-slot="changelog-media"]')).toBeNull()
  expect(entry?.querySelector('[class*="lg:grid-cols-2"]')).toBeNull()
})

it('shows an empty page when nothing has been published', async () => {
  await renderPage([])
  expect(host.textContent).toContain('还没有更新')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
})

it('shows a load error when the feed cannot be read', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
  await act(async () => {
    root.render(<ChangelogPage />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(host.textContent).toContain('更新没有加载出来')
})

it('drops a list that was in flight when the open page marked those items read', async () => {
  setAnnouncementFeed({ items: [{ ...ITEM, unread: true }], unreadCount: 1 })
  const epoch = currentAnnouncementEpoch()
  await markAnnouncementFeed([ITEM.id], false, false)
  expect(announcementUnreadCount()).toBe(0)
  expect(setAnnouncementFeed({ items: [{ ...ITEM, unread: true }], unreadCount: 1 }, epoch)).toBe(
    false,
  )
  expect(announcementUnreadCount()).toBe(0)
})

it('opens the changelog page from the sidebar and account menu', async () => {
  window.history.replaceState(null, '', '/image')
  await act(async () => {
    root.render(<AnnouncementEntry />)
  })
  await act(async () => host.querySelector('button')?.click())
  expect(location.pathname).toBe('/changelog')

  window.history.replaceState(null, '', '/image')
  const onOpen = vi.fn()
  await act(async () => {
    root.render(<AnnouncementMenuRow onOpen={onOpen} />)
  })
  await act(async () => host.querySelector('button')?.click())
  expect(onOpen).toHaveBeenCalledOnce()
  expect(location.pathname).toBe('/changelog')
})
