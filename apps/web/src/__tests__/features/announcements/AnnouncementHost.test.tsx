// @vitest-environment jsdom
import type { AnnouncementPublicItem } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnnouncementHost } from '../../../features/announcements/AnnouncementHost'
import { beginAnnouncementFeed, setAnnouncementFeed } from '../../../features/announcements/panel'
import { i18next } from '../../../i18n'
import { navigate } from '../../../lib/pathname'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const MAJOR: AnnouncementPublicItem = {
  id: 'major-1',
  type: 'feature',
  importance: 'major',
  title: 'Major release',
  body: 'Body',
  usedFallback: false,
  coverUrl: null,
  ctaLabel: null,
  ctaUrl: null,
  versionTag: 'v1.0.0',
  publishAt: Date.UTC(2026, 8, 11),
  unread: true,
  dismissed: false,
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  beginAnnouncementFeed('host-test')
  setAnnouncementFeed({ items: [], unreadCount: 0 })
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/image')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('closes an open important-announcement modal when the user navigates to the changelog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [MAJOR], unreadCount: 1 })),
  )
  await act(async () => {
    root.render(<AnnouncementHost />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()

  await act(async () => navigate('/changelog'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  // 离开更新页后不会把它再弹出来。
  await act(async () => navigate('/image'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reloads the feed in the new language when the interface language changes', async () => {
  const fetchMock = vi.fn(async (_url: string) => Response.json({ items: [], unreadCount: 0 }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => {
    root.render(<AnnouncementHost />)
  })
  const locales = () =>
    fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('locale'))
  const first = locales()[locales().length - 1]
  const original = i18next.language
  try {
    await act(async () => {
      await i18next.changeLanguage(original.startsWith('zh') ? 'en' : 'zh-CN')
    })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    expect(locales()[locales().length - 1]).not.toBe(first)
  } finally {
    await act(async () => {
      await i18next.changeLanguage(original)
    })
  }
})
