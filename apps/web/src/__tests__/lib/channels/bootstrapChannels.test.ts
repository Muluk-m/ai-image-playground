import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapChannels, preloadChannels } from '../../../lib/channels/bootstrapChannels'
import { getStoredChannels } from '../../../lib/channels/channelStore'

afterEach(() => vi.unstubAllGlobals())

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
