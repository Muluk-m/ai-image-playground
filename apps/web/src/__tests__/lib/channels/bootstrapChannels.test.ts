import { afterEach, expect, it, vi } from 'vitest'
import {
  bootstrapChannels,
  CHANNEL_REFRESH_INTERVAL_MS,
  preloadChannels,
  refreshChannels,
  refreshChannelsWhenVisible,
  resetChannelDiscoveryForTests,
} from '../../../lib/channels/bootstrapChannels'
import {
  channelsSettled,
  getStoredChannels,
  resetChannelCatalog,
  subscribeChannels,
} from '../../../lib/channels/channelStore'

afterEach(() => {
  resetChannelDiscoveryForTests()
  resetChannelCatalog()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps an aborted older channel response from replacing the latest list', async () => {
  let resolveFirst!: (response: Response) => void
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve
  })
  let requestCount = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      requestCount += 1
      return requestCount === 1
        ? firstResponse
        : Promise.resolve(Response.json({ channels: [{ id: 'new' }] }))
    }),
  )

  const controller = new AbortController()
  const older = bootstrapChannels(true, '', true, controller.signal)
  controller.abort()
  await bootstrapChannels(true, '', true)
  resolveFirst(Response.json({ channels: [{ id: 'old' }] }))
  await older

  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['new'])
})

it('uses the startup channel response for the authenticated gate', async () => {
  const fetchSpy = vi.fn(async () => Response.json({ channels: [{ id: 'ready' }] }))
  vi.stubGlobal('fetch', fetchSpy)
  preloadChannels(true, 'https://bff.example.com')
  await bootstrapChannels(true, 'https://bff.example.com', true)
  expect(fetchSpy).toHaveBeenCalledOnce()
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['ready'])
})

it('shares the preload across a cancelled StrictMode mount', async () => {
  const fetchSpy = vi.fn(async () => Response.json({ channels: [{ id: 'ready' }] }))
  vi.stubGlobal('fetch', fetchSpy)
  preloadChannels(true, 'https://strict.example.com')
  const firstController = new AbortController()
  const first = bootstrapChannels(true, 'https://strict.example.com', true, firstController.signal)
  firstController.abort()
  await bootstrapChannels(true, 'https://strict.example.com', true)
  await first
  expect(fetchSpy).toHaveBeenCalledOnce()
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['ready'])
})

it('retries discovery after a failed startup preload', async () => {
  const fetchSpy = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ channels: [{ id: 'recovered' }] }))
  vi.stubGlobal('fetch', fetchSpy)
  preloadChannels(true, 'https://retry.example.com')
  await expect(bootstrapChannels(true, 'https://retry.example.com', true)).rejects.toThrow()
  await bootstrapChannels(true, 'https://retry.example.com', true)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['recovered'])
})

it('ignores an old channel preload after the backend is disabled', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  preloadChannels(true, 'https://old.example.com')
  preloadChannels(false, '')
  finish(Response.json({ channels: [{ id: 'stale' }] }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(getStoredChannels()).toEqual([])
})

it('retries a failed catalog without treating an empty list as loaded', async () => {
  const channel = {
    id: 'back',
    kind: 'openai-queue',
    label: 'Back',
    models: [{ id: 'gpt-image-2', label: 'GPT', capabilities: ['generate'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }
  vi.useFakeTimers()
  const fetchSpy = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ channels: [channel] }))
  vi.stubGlobal('fetch', fetchSpy)

  preloadChannels(true, 'https://retry-later.example.com')
  await Promise.resolve()
  await Promise.resolve()

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(channelsSettled()).toBe(false)
  expect(getStoredChannels()).toEqual([])

  await vi.advanceTimersByTimeAsync(1000)

  expect(channelsSettled()).toBe(true)
  expect(getStoredChannels().map((item) => item.id)).toEqual(['back'])
})

/** 启动时拿到 `first`，之后每次刷新按 `next` 回答；返回 fetch 桩。 */
async function startedWith(first: string, next: () => Promise<Response>) {
  let calls = 0
  const fetchSpy = vi.fn(() => {
    calls += 1
    return calls === 1 ? Promise.resolve(Response.json({ channels: [{ id: first }] })) : next()
  })
  vi.stubGlobal('fetch', fetchSpy)
  await bootstrapChannels(true, 'https://bff.example.com', true)
  return fetchSpy
}

it('refreshes the channel list once the last one is old enough, and not before', async () => {
  const fetchSpy = await startedWith('old', async () =>
    Response.json({ channels: [{ id: 'new' }] }),
  )
  await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS - 1_000)
  expect(fetchSpy).toHaveBeenCalledOnce()
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['old'])
  await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['new'])
  // 刚刷新过：同一时刻再问不会再发请求。
  await refreshChannels(Date.now())
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

it('shares one refresh between concurrent callers', async () => {
  let answer!: (response: Response) => void
  const fetchSpy = await startedWith(
    'old',
    () => new Promise<Response>((resolve) => (answer = resolve)),
  )
  const later = Date.now() + CHANNEL_REFRESH_INTERVAL_MS
  const first = refreshChannels(later)
  const second = refreshChannels(later)
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  answer(Response.json({ channels: [{ id: 'new' }] }))
  await Promise.all([first, second])
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['new'])
})

it('keeps the current list when a refresh fails', async () => {
  const fetchSpy = await startedWith('old', async () => {
    throw new TypeError('offline')
  })
  await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(channelsSettled()).toBe(true)
  expect(getStoredChannels().map((channel) => channel.id)).toEqual(['old'])
})

it('does not notify subscribers when the refreshed list is unchanged', async () => {
  const fetchSpy = await startedWith('same', async () =>
    Response.json({ channels: [{ id: 'same' }] }),
  )
  const listener = vi.fn()
  const unsubscribe = subscribeChannels(listener)
  try {
    await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()
    // 没变也算刚问过：不会紧接着再问。
    await refreshChannels(Date.now())
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  } finally {
    unsubscribe()
  }
})

it('does not refresh before the first list arrived or when the BFF is off', async () => {
  const fetchSpy = vi.fn(async () => Response.json({ channels: [] }))
  vi.stubGlobal('fetch', fetchSpy)
  await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
  await bootstrapChannels(false, '')
  await refreshChannels(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('refreshes when the tab comes back to the foreground and stops after unsubscribing', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const fetchSpy = await startedWith('old', async () =>
    Response.json({ channels: [{ id: 'new' }] }),
  )
  // 测试跑在 node 里：用一对 EventTarget 充当窗口与文档。
  const page = Object.assign(new EventTarget(), {
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  })
  const stop = refreshChannelsWhenVisible(page as unknown as Window)
  try {
    vi.setSystemTime(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
    page.dispatchEvent(new Event('focus'))
    await vi.waitFor(() =>
      expect(getStoredChannels().map((channel) => channel.id)).toEqual(['new']),
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  } finally {
    stop()
  }
  vi.setSystemTime(Date.now() + CHANNEL_REFRESH_INTERVAL_MS)
  page.dispatchEvent(new Event('focus'))
  page.document.dispatchEvent(new Event('visibilitychange'))
  await Promise.resolve()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

it('keeps refreshing on an interval while the tab stays in the foreground', async () => {
  vi.useFakeTimers()
  const fetchSpy = await startedWith('old', async () =>
    Response.json({ channels: [{ id: 'new' }] }),
  )
  const page = Object.assign(new EventTarget(), {
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  })
  const stop = refreshChannelsWhenVisible(page as unknown as Window)
  try {
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_INTERVAL_MS - 1_000)
    expect(fetchSpy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(getStoredChannels().map((channel) => channel.id)).toEqual(['new'])
  } finally {
    stop()
  }
  await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_INTERVAL_MS * 2)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})
