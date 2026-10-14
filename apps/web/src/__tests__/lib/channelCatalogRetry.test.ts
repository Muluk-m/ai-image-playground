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
