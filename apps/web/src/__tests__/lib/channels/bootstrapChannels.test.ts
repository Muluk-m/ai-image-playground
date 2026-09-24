import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapChannels } from '../../../lib/channels/bootstrapChannels'
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
