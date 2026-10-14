import { afterEach, describe, expect, it, vi } from 'vitest'
import { callImageApi, resumeQueueImageApi } from '../../lib/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import type { BuiltinEdgeProfile, PublicChannel } from '../../lib/channels/types'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
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

describe('callImageApi', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    mockChannels.list = []
    await bootstrapClientCapabilities(false, '')
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
          id: 'agnes-image-2.5-flash',
          label: 'Agnes Image 2.5 Flash',
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
      models: [{ id: 'agnes-image-2.5-flash', label: 'Agnes', capabilities: ['generate', 'edit'] }],
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
})
