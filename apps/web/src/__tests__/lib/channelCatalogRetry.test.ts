import { afterEach, expect, it, vi } from 'vitest'
import { callImageApi } from '../../lib/api'
import { normalizeSettings } from '../../lib/apiProfiles'
import { resetChannelDiscoveryForTests } from '../../lib/channels/bootstrapChannels'
import { resetChannelCatalog, setChannels } from '../../lib/channels/channelStore'
import type { PublicChannel } from '../../lib/channels/types'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { DEFAULT_PARAMS } from '../../types'

const CHANNEL: PublicChannel = {
  id: 'openai-images',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
  defaults: { apiMode: 'images', timeout: 600 },
}

afterEach(() => {
  resetChannelDiscoveryForTests()
  resetChannelCatalog()
  _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('does not report a missing channel while discovery is retrying, then generates after the catalog arrives', async () => {
  resetChannelCatalog()
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
  const settings = normalizeSettings({
    profiles: [
      {
        id: CHANNEL.id,
        source: 'builtin-edge',
        channelId: CHANNEL.id,
        selectedModelId: 'gpt-image-2',
      },
    ],
    activeProfileId: CHANNEL.id,
  })
  expect(settings.profiles[0]?.selectedModelId).toBe('gpt-image-2')

  let channelsUp = false
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/channels')) {
        if (!channelsUp) return new Response('offline', { status: 503 })
        return Response.json({ channels: [CHANNEL] })
      }
      if (url.endsWith('/submit')) {
        return Response.json({ request_id: 'rid-1', status: 'queued', submitted_at: 0 })
      }
      if (url.endsWith('/status')) {
        return Response.json({
          request_id: 'rid-1',
          status: 'completed',
          submitted_at: 0,
          result: { images: [{ index: 0, mime: 'image/png' }] },
        })
      }
      if (url.includes('/image/')) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { 'Content-Type': 'image/png' },
        })
      }
      return Response.json({})
    }),
  )

  await expect(
    callImageApi({
      settings,
      prompt: 'a cat',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }),
  ).rejects.toThrow('平台渠道暂时连不上')
  expect(urls.some((url) => url.includes('/submit'))).toBe(false)

  channelsUp = true
  setChannels([CHANNEL])
  const result = await callImageApi({
    settings,
    prompt: 'a cat',
    params: { ...DEFAULT_PARAMS },
    inputImageDataUrls: [],
  })
  expect(result.images.length).toBeGreaterThan(0)
  expect(urls.some((url) => url.includes('/submit'))).toBe(true)
})

function queueFetch(channels: PublicChannel[], urls: string[]) {
  return async (input: string) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/api/channels')) return Response.json({ channels })
    if (url.endsWith('/submit')) {
      return Response.json({ request_id: 'rid-1', status: 'queued', submitted_at: 0 })
    }
    if (url.endsWith('/status')) {
      return Response.json({
        request_id: 'rid-1',
        status: 'completed',
        submitted_at: 0,
        result: { images: [{ index: 0, mime: 'image/png' }] },
      })
    }
    if (url.includes('/image/')) {
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return Response.json({})
  }
}

it('submits the model that is still listed after the catalog loads', async () => {
  resetChannelCatalog()
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
  const settings = normalizeSettings({
    profiles: [
      {
        id: CHANNEL.id,
        source: 'builtin-edge',
        channelId: CHANNEL.id,
        selectedModelId: 'retired-model',
      },
    ],
    activeProfileId: CHANNEL.id,
  })
  expect(settings.profiles[0]?.selectedModelId).toBe('retired-model')
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(queueFetch([CHANNEL], urls)))

  const result = await callImageApi({
    settings,
    prompt: 'a cat',
    params: { ...DEFAULT_PARAMS },
    inputImageDataUrls: [],
  })

  expect(result.images.length).toBeGreaterThan(0)
  expect(urls.some((url) => url.includes('/retired-model/'))).toBe(false)
  expect(urls.some((url) => url.includes('/gpt-image-2/submit'))).toBe(true)
})

it('shares one catalog load across parallel submissions', async () => {
  resetChannelCatalog()
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
  const settings = normalizeSettings({
    profiles: [
      {
        id: CHANNEL.id,
        source: 'builtin-edge',
        channelId: CHANNEL.id,
        selectedModelId: 'gpt-image-2',
      },
    ],
    activeProfileId: CHANNEL.id,
  })
  let releaseChannels!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    releaseChannels = resolve
  })
  let channelFetches = 0
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/channels')) {
        channelFetches += 1
        return gate
      }
      return queueFetch([CHANNEL], [])(url)
    }),
  )

  const pending = Promise.all([
    callImageApi({
      settings,
      prompt: 'one',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }),
    callImageApi({
      settings,
      prompt: 'two',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }),
  ])
  await vi.waitFor(() => expect(channelFetches).toBe(1))
  expect(urls.some((url) => url.includes('/submit'))).toBe(false)
  releaseChannels(Response.json({ channels: [CHANNEL] }))
  const results = await pending

  expect(channelFetches).toBe(1)
  expect(results.map((result) => result.images.length)).toEqual([1, 1])
  expect(urls.filter((url) => url.endsWith('/submit'))).toHaveLength(2)
  expect(urls.some((url) => url.includes('平台渠道暂时连不上'))).toBe(false)
})
