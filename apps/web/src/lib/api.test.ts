import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AppSettings } from '../types'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import type { BuiltinEdgeProfile, PublicChannel, UserByokProfile } from './channels/types'
import { callImageApi } from './api'

const mockChannels = vi.hoisted(() => ({ list: [] as PublicChannel[] }))
vi.mock('./channels/publicChannels', () => ({
  getPublicChannels: () => mockChannels.list,
  getPublicChannel: (id: string) => mockChannels.list.find((c) => c.id === id),
}))

// canvasImage 依赖 DOM Image()，jsdom 不支持；只覆盖 dispatch 路径时 mock 掉
vi.mock('./canvasImage', () => ({
  imageDataUrlToPngBlob: vi.fn(async () => new Blob(['fake'], { type: 'image/png' })),
  maskDataUrlToPngBlob: vi.fn(async () => new Blob(['fake'], { type: 'image/png' })),
}))

function expectNoAuthHeaders(headers: Record<string, string>): void {
  expect(headers.Authorization).toBeUndefined()
  expect(headers.authorization).toBeUndefined()
  expect(headers['x-api-key']).toBeUndefined()
  expect(headers['x-goog-api-key']).toBeUndefined()
}

function settingsWithBuiltin(channel: PublicChannel, selectedModelId = channel.models[0].id): AppSettings {
  const profile: BuiltinEdgeProfile = {
    id: `builtin-${channel.id}`,
    source: 'builtin-edge',
    channelId: channel.id,
    selectedModelId,
  }
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [profile],
    activeProfileId: profile.id,
  })
}

function settingsWithByok(overrides: {
  apiKey?: string
  baseUrl?: string
  model?: string
  apiMode?: 'images' | 'responses'
  codexCli?: boolean
  apiProxy?: boolean
  responseFormatB64Json?: boolean
  timeout?: number
} = {}): AppSettings {
  const baseUrl = overrides.baseUrl ?? 'https://api.openai.com/v1'
  const model = overrides.model ?? 'gpt-image-2'
  const profile: UserByokProfile = {
    id: 'test-profile',
    source: 'user-byok',
    name: 'Test',
    kind: 'openai-compat',
    baseUrl,
    apiKey: overrides.apiKey ?? '',
    models: [model],
    selectedModelId: model,
    preferences: {
      apiMode: overrides.apiMode ?? 'images',
      timeout: overrides.timeout ?? 600,
      codexCli: overrides.codexCli ?? false,
      apiProxy: overrides.apiProxy ?? false,
      responseFormatB64Json: overrides.responseFormatB64Json,
    },
  }
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [profile],
    activeProfileId: profile.id,
  })
}

describe('callImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    mockChannels.list = []
  })

  it.each([false, true])(
    'adds the prompt rewrite guard on Responses API when Codex CLI mode is %s',
    async (codexCli) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'aW1hZ2U=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

      await callImageApi({
        settings: settingsWithByok({ apiKey: 'test-key', apiMode: 'responses', codexCli }),
        prompt: 'prompt',
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      })

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.input).toBe('Use the following text as the complete prompt. Do not rewrite it:\nprompt')
    },
  )

  it('records actual params returned on Images API responses in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
      data: [{ b64_json: 'aW1hZ2U=', revised_prompt: '移除靴子' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key', codexCli: true }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.actualParams).toEqual({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
    })
    expect(result.revisedPrompts).toEqual(['移除靴子'])
  })

  it('uses the same-origin API proxy path when API proxy is enabled', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: settingsWithByok({
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not add cache request headers that require extra CORS allow-list entries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers).not.toHaveProperty('Pragma')
    expect(headers).not.toHaveProperty('Cache-Control')
    expect((init as RequestInit).cache).toBe('no-store')
  })

  it('ignores stored API proxy settings when the current deployment has no proxy', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: settingsWithByok({
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  // Helper: builtin-edge 走 queue 时 fetch 序列是 submit → status → result，分别用不同 payload mock
  function mockQueueFlow(provider: 'openai-compat' | 'gemini', resultPayload: unknown): { fetchMock: ReturnType<typeof vi.spyOn> } {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/queue/') && url.endsWith('/submit')) {
        return new Response(JSON.stringify({ request_id: 'rid-1', status: 'queued', submitted_at: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/status')) {
        return new Response(JSON.stringify({ request_id: 'rid-1', status: 'completed', submitted_at: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/v1/queue/requests/')) {
        return new Response(JSON.stringify({ request_id: 'rid-1', status: 'completed', payload: resultPayload }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`)
    })
    void provider
    return { fetchMock }
  }

  it('builtin-edge openai-compat with codexCli prefixes prompt guard and drops quality (queue submit body)', async () => {
    const channel: PublicChannel = {
      id: 'test-codex',
      kind: 'openai-compat',
      label: 'Codex',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
      defaults: { apiMode: 'images', timeout: 600, codexCli: true },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat', { data: [{ b64_json: 'aW1hZ2U=' }] })

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) => String(url).endsWith('/submit'))!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('Use the following text as the complete prompt. Do not rewrite it:\na red cat')
    expect(body).not.toHaveProperty('quality')
  })

  it('builtin-edge openai-compat without codexCli sends raw prompt and quality (queue submit body)', async () => {
    const channel: PublicChannel = {
      id: 'test-plain',
      kind: 'openai-compat',
      label: 'Plain',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat', { data: [{ b64_json: 'aW1hZ2U=' }] })

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) => String(url).endsWith('/submit'))!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
    expect(body.quality).toBe('high')
  })

  it('builtin-edge openai-compat dispatch routes to /v1/queue/openai-compat/... without Authorization', async () => {
    const channel: PublicChannel = {
      id: 'test-openai',
      kind: 'openai-compat',
      label: 'Test OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat', { data: [{ b64_json: 'aW1hZ2U=' }] })

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) => String(url).endsWith('/submit'))!
    expect(submitCall[0]).toBe('/v1/queue/openai-compat/gpt-image-2/submit')
    expectNoAuthHeaders(((submitCall[1] as RequestInit).headers ?? {}) as Record<string, string>)
  })

  it('builtin-edge gemini dispatch routes to /v1/queue/gemini/... without Authorization', async () => {
    const channel: PublicChannel = {
      id: 'test-gemini',
      kind: 'gemini',
      label: 'Test Gemini',
      models: [{ id: 'gemini-3.1-flash-image', label: 'Gemini Flash Image' }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('gemini', {
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
      }],
    })

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) => String(url).endsWith('/submit'))!
    expect(submitCall[0]).toBe('/v1/queue/gemini/gemini-3.1-flash-image/submit')
    expectNoAuthHeaders(((submitCall[1] as RequestInit).headers ?? {}) as Record<string, string>)
  })

  it('builtin-edge with maskDataUrl falls back to /api-proxy/ edge path (queue does not handle FormData masks)', async () => {
    const channel: PublicChannel = {
      id: 'test-openai-mask',
      kind: 'openai-compat',
      label: 'Mask',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'p',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api-proxy/test-openai-mask/images/edits')
  })

  it('user-byok dispatch always carries Authorization header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'sk-test' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
  })
})
