import { afterEach, describe, expect, it, vi } from 'vitest'
import { callImageApi, resumeQueueImageApi } from '../../lib/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import type { BuiltinEdgeProfile, PublicChannel, UserByokProfile } from '../../lib/channels/types'
import { buildAspectInstruction } from '../../lib/size'
import { type AppSettings, DEFAULT_PARAMS } from '../../types'

const mockChannels = vi.hoisted(() => ({ list: [] as PublicChannel[] }))
vi.mock('../../lib/channels/publicChannels', () => ({
  getPublicChannels: () => mockChannels.list,
  getPublicChannel: (id: string) => mockChannels.list.find((c) => c.id === id),
}))

// canvasImage 依赖 DOM Image()，jsdom 不支持；只覆盖 dispatch 路径时 mock 掉
vi.mock('../../lib/canvasImage', () => ({
  dataUrlToBlob: vi.fn(async () => new Blob(['fake'], { type: 'image/png' })),
  imageDataUrlToPngBlob: vi.fn(async () => new Blob(['fake'], { type: 'image/png' })),
  maskDataUrlToPngBlob: vi.fn(async () => new Blob(['fake'], { type: 'image/png' })),
  createMaskPreviewDataUrl: vi.fn(async () => 'data:image/png;base64,YW5ub3RhdGVk'),
}))

function expectNoAuthHeaders(headers: Record<string, string>): void {
  expect(headers.Authorization).toBeUndefined()
  expect(headers.authorization).toBeUndefined()
  expect(headers['x-api-key']).toBeUndefined()
  expect(headers['x-goog-api-key']).toBeUndefined()
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}

function settingsWithBuiltin(
  channel: PublicChannel,
  selectedModelId = channel.models[0].id,
): AppSettings {
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

function settingsWithByok(
  overrides: {
    apiKey?: string
    baseUrl?: string
    model?: string
    apiMode?: 'images' | 'responses'
    codexCli?: boolean
    apiProxy?: boolean
    responseFormatB64Json?: boolean
    timeout?: number
  } = {},
): AppSettings {
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

describe('buildAspectInstruction', () => {
  it('builds a portrait composition sentence from a parseable size', () => {
    const expected = 'Composition: a tall 9:16 vertical frame, portrait orientation.'

    expect(buildAspectInstruction('1024x1824')).toBe(expected)
    expect(buildAspectInstruction(' 1024 × 1824 ')).toBe(expected)
  })

  it('returns null for auto size', () => {
    expect(buildAspectInstruction('auto')).toBeNull()
  })
})

describe('callImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    mockChannels.list = []
  })

  it('adds prompt guard on Responses API by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'image_generation_call',
              result: 'aW1hZ2U=',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key', apiMode: 'responses' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.input).toBe(
      'Use the following text as the complete prompt. Do not rewrite it:\nprompt',
    )
  })

  it('records actual params returned on Images API responses in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output_format: 'png',
          quality: 'medium',
          size: '1033x1522',
          data: [{ b64_json: 'aW1hZ2U=', revised_prompt: '移除靴子' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

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

  it('parses Images API stream result events with final data payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        {
          type: 'image.generation.result',
          data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'stream prompt' }],
          size: '1024x1024',
        },
      ]),
    )

    const result = await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.actualParams).toEqual({ size: '1024x1024' })
    expect(result.revisedPrompts).toEqual(['stream prompt'])
  })

  it('parses Images API completed stream events with top-level image data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        {
          type: 'image_edit.completed',
          b64_json: 'ZWRpdA==',
          revised_prompt: 'edited prompt',
          quality: 'high',
        },
      ]),
    )

    const result = await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })

    expect(result.images).toEqual(['data:image/png;base64,ZWRpdA=='])
    expect(result.actualParams).toEqual({ quality: 'high' })
    expect(result.revisedPrompts).toEqual(['edited prompt'])
  })

  it('keeps per-image params aligned when some completed stream events carry no b64_json', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'image_generation.completed', revised_prompt: 'no image event' },
        {
          type: 'image_generation.completed',
          b64_json: 'aW1hZ2U=',
          revised_prompt: 'real prompt',
          size: '512x512',
        },
      ]),
    )

    const result = await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.actualParamsList).toEqual([{ size: '512x512' }])
    expect(result.revisedPrompts).toEqual(['real prompt'])
  })

  it('does not add cache request headers that require extra CORS allow-list entries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'aW1hZ2U=' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

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

  it('ignores stored apiProxy=true preference when no dev-proxy is configured', async () => {
    // 没有 dev-proxy.config.json 注入时 isApiProxyAvailable() = false，
    // BYOK 用户的 apiProxy=true 偏好被无视，请求直连用户填的 baseUrl。
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'aW1hZ2U=' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

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

  // Helper: builtin-edge queue 模式 fetch 序列：
  //   submit → status → result-meta → image/0 (binary)
  // result-meta 直接给 BFF 已抽好的 images 数组；image/N 走二进制端点。
  function mockQueueFlow(
    provider: 'openai-compat' | 'gemini',
    imageBytesB64: string = 'aW1hZ2U=',
  ): { fetchMock: ReturnType<typeof vi.spyOn> } {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/queue/') && url.endsWith('/submit')) {
        return new Response(
          JSON.stringify({ request_id: 'rid-1', status: 'queued', submitted_at: 0 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      if (url.endsWith('/status')) {
        return new Response(
          JSON.stringify({ request_id: 'rid-1', status: 'completed', submitted_at: 0 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      // /v1/queue/requests/{id}/image/{idx} → 原始 PNG/Gemini 字节
      const binMatch = /\/v1\/queue\/requests\/[^/]+\/image\/(\d+)/.exec(url)
      if (binMatch) {
        const bytes = Uint8Array.from(atob(imageBytesB64), (c) => c.charCodeAt(0))
        return new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      }
      if (url.includes('/v1/queue/requests/')) {
        return new Response(
          JSON.stringify({
            request_id: 'rid-1',
            status: 'completed',
            images: [{ index: 0, mime: 'image/png' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`)
    })
    void provider
    return { fetchMock }
  }

  it('appends the requested portrait composition for builtin-edge models without size capability', async () => {
    const channel: PublicChannel = {
      id: 'test-no-size',
      kind: 'openai-queue',
      label: 'No Size',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, size: '1024x1824', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe(
      'a red cat\n\nComposition: a tall 9:16 vertical frame, portrait orientation.',
    )
  })

  it('does not append a composition for auto size', async () => {
    const channel: PublicChannel = {
      id: 'test-auto-size',
      kind: 'openai-queue',
      label: 'Auto Size',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, size: 'auto', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
  })

  it('does not append a composition for builtin-edge models with size capability', async () => {
    const channel: PublicChannel = {
      id: 'test-with-size',
      kind: 'openai-queue',
      label: 'With Size',
      models: [
        {
          id: 'agnes-image-2.1-flash',
          label: 'Agnes Image 2.1 Flash',
          capabilities: ['generate', 'edit', 'size'],
        },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, size: '1024x1824', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
  })

  it('does not append a composition for BYOK profiles without declared capabilities', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, size: '1024x1824', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
  })

  it('places the composition after the prompt-rewrite guard', async () => {
    const channel: PublicChannel = {
      id: 'test-no-size-guard',
      kind: 'openai-queue',
      label: 'No Size Guard',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, size: '1024x1824', no_rewrite: true },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe(
      'Use the following text as the complete prompt. Do not rewrite it:\na red cat\n\n' +
        'Composition: a tall 9:16 vertical frame, portrait orientation.',
    )
  })

  it('builtin-edge openai-compat with codexCli adds prompt guard by default and drops quality (queue submit body)', async () => {
    const channel: PublicChannel = {
      id: 'test-codex',
      kind: 'openai-queue',
      label: 'Codex',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600, codexCli: true },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe(
      'Use the following text as the complete prompt. Do not rewrite it:\na red cat',
    )
    expect(body).not.toHaveProperty('quality')
  })

  it('params.no_rewrite=false sends raw prompt and quality on plain builtin-edge channel', async () => {
    const channel: PublicChannel = {
      id: 'test-plain',
      kind: 'openai-queue',
      label: 'Plain',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
    expect(body.quality).toBe('high')
  })

  it('params.no_rewrite=false sends raw prompt on codexCli channel, quality still dropped', async () => {
    const channel: PublicChannel = {
      id: 'test-codex',
      kind: 'openai-queue',
      label: 'Codex',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600, codexCli: true },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high', no_rewrite: false },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe('a red cat')
    expect(body).not.toHaveProperty('quality')
  })

  it('params.no_rewrite=true adds prompt guard on plain builtin-edge channel, quality untouched', async () => {
    const channel: PublicChannel = {
      id: 'test-plain',
      kind: 'openai-queue',
      label: 'Plain',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'a red cat',
      params: { ...DEFAULT_PARAMS, quality: 'high', no_rewrite: true },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse(String((submitCall[1] as RequestInit).body))
    expect(body.prompt).toBe(
      'Use the following text as the complete prompt. Do not rewrite it:\na red cat',
    )
    expect(body.quality).toBe('high')
  })

  it('params.no_rewrite=false sends raw prompt on BYOK Images API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, no_rewrite: false },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.prompt).toBe('prompt')
  })

  it('BYOK Images API with codexCli adds prompt guard by default and drops quality', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key', codexCli: true }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.prompt).toBe(
      'Use the following text as the complete prompt. Do not rewrite it:\nprompt',
    )
    expect(body).not.toHaveProperty('quality')
  })

  it('params.no_rewrite=false sends raw prompt on Responses API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await callImageApi({
      settings: settingsWithByok({ apiKey: 'test-key', apiMode: 'responses' }),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, no_rewrite: false },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.input).toBe('prompt')
  })

  it('builtin-edge openai-compat dispatch routes to /v1/queue/openai-compat/... without Authorization', async () => {
    const channel: PublicChannel = {
      id: 'test-openai',
      kind: 'openai-queue',
      label: 'Test OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    expect(submitCall[0]).toBe('/v1/queue/openai-compat/gpt-image-2/submit')
    expectNoAuthHeaders(((submitCall[1] as RequestInit).headers ?? {}) as Record<string, string>)
  })

  it('builtin-edge gemini dispatch routes to /v1/queue/gemini/... without Authorization', async () => {
    const channel: PublicChannel = {
      id: 'test-gemini',
      kind: 'gemini-queue',
      label: 'Test Gemini',
      models: [
        { id: 'gemini-3.1-flash-image', label: 'Gemini Flash Image', capabilities: ['generate'] },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]

    const { fetchMock } = mockQueueFlow('gemini')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    expect(submitCall[0]).toBe('/v1/queue/gemini/gemini-3.1-flash-image/submit')
    expectNoAuthHeaders(((submitCall[1] as RequestInit).headers ?? {}) as Record<string, string>)
  })

  it('builtin-edge mask 模型（capability mask）原生透传 mask + input_images 到 queue submit', async () => {
    const channel: PublicChannel = {
      id: 'test-openai-mask',
      kind: 'openai-queue',
      label: 'Mask',
      models: [
        { id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit', 'mask'] },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'p',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const [submitUrl, submitInit] = submitCall as [string, RequestInit]
    expect(submitUrl).toMatch(/\/v1\/queue\/openai-compat\/gpt-image-2\/submit$/)
    const body = JSON.parse(submitInit.body as string)
    expect(body.input_images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(body.mask).toBe('data:image/png;base64,bWFzaw==')
  })

  it('builtin-edge 非 mask 模型（无 capability mask）走软遮罩降级：标注图入 input_images、prompt 注入、不带 mask', async () => {
    const channel: PublicChannel = {
      id: 'test-softmask',
      kind: 'openai-queue',
      label: 'SoftMask',
      // Agnes 风格：支持 edit 但无原生 mask 能力
      models: [{ id: 'agnes-image-2.1-flash', label: 'Agnes', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: '把高亮处换成猫',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const submitCall = fetchMock.mock.calls.find(([url]: [unknown, unknown]) =>
      String(url).endsWith('/submit'),
    )!
    const body = JSON.parse((submitCall[1] as RequestInit).body as string)
    // 软遮罩：不透传 mask 字段；input_images = [原图, 标注图]；prompt 前注入区域指令
    expect(body.mask).toBeUndefined()
    expect(body.input_images).toEqual([
      'data:image/png;base64,aW1hZ2U=',
      'data:image/png;base64,YW5ub3RhdGVk',
    ])
    expect(body.prompt).toContain('marked region')
    expect(body.prompt).toContain('把高亮处换成猫')
  })

  it('queue submit fires onQueueSubmitted callback with request_id', async () => {
    const channel: PublicChannel = {
      id: 'test-cb',
      kind: 'openai-queue',
      label: 'Callback',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    mockQueueFlow('openai-compat')

    const onQueueSubmitted = vi.fn()
    await callImageApi({
      settings: settingsWithBuiltin(channel),
      prompt: 'p',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onQueueSubmitted,
    })

    expect(onQueueSubmitted).toHaveBeenCalledWith('rid-1')
  })

  it('resumeQueueImageApi skips /submit and goes straight to status + result', async () => {
    const channel: PublicChannel = {
      id: 'test-resume',
      kind: 'openai-queue',
      label: 'Resume',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    mockChannels.list = [channel]
    const { fetchMock } = mockQueueFlow('openai-compat')

    await resumeQueueImageApi(
      {
        settings: settingsWithBuiltin(channel),
        prompt: 'p',
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      },
      'persisted-request-id-42',
    )

    const urls: string[] = fetchMock.mock.calls.map(([u]: [unknown, unknown]) => String(u))
    expect(urls.some((u: string) => u.endsWith('/submit'))).toBe(false)
    expect(urls.some((u: string) => u.includes('persisted-request-id-42/status'))).toBe(true)
    expect(urls.some((u: string) => u.endsWith('/v1/queue/requests/persisted-request-id-42'))).toBe(
      true,
    )
  })

  it('user-byok dispatch always carries Authorization header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'aW1hZ2U=' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

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
