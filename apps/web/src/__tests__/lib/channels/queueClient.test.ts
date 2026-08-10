import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { callQueueChannelApi } from '../../../lib/channels/queueClient'
import type { BuiltinEdgeProfile, PublicChannel } from '../../../lib/channels/types'

const STORAGE_KEY = 'image-playground.device_id'

/**
 * Vitest 默认跑在 node env，无 DOM。手动塞个最小 localStorage shim，
 * 行为对齐 Web Storage（同步、错误时抛）。
 */
function makeLocalStorageShim(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
}

type MockQueueProvider = 'openai-compat' | 'gemini'

const MODEL_ID_BY_PROVIDER: Record<MockQueueProvider, string> = {
  'openai-compat': 'gpt-image-1',
  gemini: 'gemini-3-pro-image-preview',
}

function mockChannel(provider: MockQueueProvider = 'openai-compat'): PublicChannel {
  const modelId = MODEL_ID_BY_PROVIDER[provider]
  return {
    id: `test-${provider}-queue`,
    kind: provider === 'gemini' ? 'gemini-queue' : 'openai-queue',
    label: 'test',
    bffBaseUrl: 'https://bff.example.com',
    provider,
    models: [{ id: modelId, label: modelId }],
    defaultModel: modelId,
    defaults: {},
  } as unknown as PublicChannel
}

function mockProfile(provider: MockQueueProvider = 'openai-compat'): BuiltinEdgeProfile {
  return {
    selectedModelId: MODEL_ID_BY_PROVIDER[provider],
  } as unknown as BuiltinEdgeProfile
}

function mockOpts(params: Partial<Parameters<typeof callQueueChannelApi>[0]['params']> = {}) {
  return {
    prompt: 'a cat',
    params: {
      size: 'auto',
      quality: 'auto',
      output_format: 'png',
      output_compression: null,
      moderation: 'auto',
      n: 1,
      ...params,
    },
    inputImageDataUrls: [],
    maskDataUrl: undefined,
    clientRequestId: 'req-aaaa-bbbb-cccc',
  } as unknown as Parameters<typeof callQueueChannelApi>[0]
}

/** deviceId 有模块级缓存，必须在 vi.resetModules() 后重新加载被测模块。 */
async function loadCallQueueChannelApi() {
  return (await import('../../../lib/channels/queueClient')).callQueueChannelApi
}

/** 按顺序给 fetch 排队若干个 200 JSON 响应；返回 spy 以便继续追加非 JSON 响应。 */
function mockFetchJson(...payloads: unknown[]) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  for (const payload of payloads) {
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    )
  }
  return fetchSpy
}

async function captureSubmitBody(
  provider: MockQueueProvider,
  params: Partial<Parameters<typeof callQueueChannelApi>[0]['params']> = {},
) {
  const call = await loadCallQueueChannelApi()
  const fetchSpy = mockFetchJson(
    { request_id: 'rid-1', status: 'queued' },
    {
      request_id: 'rid-1',
      status: 'failed',
      submitted_at: Date.now(),
      error: { message: 'test-stop', type: 'unknown' },
    },
  )

  await expect(
    call(mockOpts(params), mockProfile(provider), mockChannel(provider)),
  ).rejects.toThrow('test-stop')

  const firstCall = fetchSpy.mock.calls[0]!
  const init = firstCall[1] as RequestInit
  return {
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
    url: String(firstCall[0]),
    credentials: init.credentials,
  }
}

describe('callQueueChannelApi submit body', () => {
  beforeEach(() => {
    const shim = makeLocalStorageShim()
    vi.stubGlobal('localStorage', shim)
    localStorage.setItem(STORAGE_KEY, 'dev-aaaa-bbbb-cccc')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('submit body 包含 device_id 字段', async () => {
    const { body, url, credentials } = await captureSubmitBody('openai-compat')

    expect(url).toContain('/v1/queue/openai-compat/gpt-image-1/submit')
    expect(body.device_id).toBe('dev-aaaa-bbbb-cccc')
    // 认证部署下 session cookie 必须跟着 submit 走，否则 BFF 认不出账号。
    expect(credentials).toBe('include')
  })

  it('openai-compat 透传非 PNG 输出参数', async () => {
    const { body } = await captureSubmitBody('openai-compat', {
      output_format: 'webp',
      output_compression: 72,
      moderation: 'low',
    })

    expect(body).toMatchObject({
      output_format: 'webp',
      output_compression: 72,
      moderation: 'low',
    })
  })

  it('openai-compat 的 PNG 输出不发送压缩率', async () => {
    const { body } = await captureSubmitBody('openai-compat', {
      output_format: 'png',
      output_compression: 72,
      moderation: 'auto',
    })

    expect(body).toMatchObject({ output_format: 'png', moderation: 'auto' })
    expect(body).not.toHaveProperty('output_compression')
  })

  it('gemini 发送派生比例和 Gemini 专属参数，不发送 OpenAI 专属参数', async () => {
    const { body } = await captureSubmitBody('gemini', {
      size: '1792x1024',
      gemini_image_size: '2K',
      gemini_thinking_level: 'high',
      output_format: 'webp',
      output_compression: 72,
      moderation: 'low',
    })

    expect(body).toMatchObject({
      aspect_ratio: '16:9',
      image_size: '2K',
      thinking_level: 'high',
    })
    expect(body).not.toHaveProperty('output_format')
    expect(body).not.toHaveProperty('output_compression')
    expect(body).not.toHaveProperty('moderation')
  })

  it('completed result 透传合法的实际输出格式', async () => {
    const call = await loadCallQueueChannelApi()
    const fetchSpy = mockFetchJson(
      { request_id: 'rid-1', status: 'queued' },
      {
        request_id: 'rid-1',
        status: 'completed',
        submitted_at: Date.now(),
        result: {
          images: [{ index: 0, mime: 'image/webp', size_bytes: 2 }],
          actual_params: { output_format: 'webp' },
        },
      },
    )
    fetchSpy.mockImplementationOnce(
      async () => new Response('ok', { status: 200, headers: { 'content-type': 'image/webp' } }),
    )

    const result = await call(mockOpts(), mockProfile(), mockChannel())

    expect(result.actualParams).toEqual({ output_format: 'webp' })
  })

  it('429 daily_quota_exceeded 抛中文错误且 quotaExceeded=true', async () => {
    const call = await loadCallQueueChannelApi()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'daily_quota_exceeded',
            quota: 50,
            used: 50,
            reset_at: '2026-05-16T00:00:00.000Z',
          }),
          { status: 429 },
        ),
    )

    try {
      await call(mockOpts(), mockProfile(), mockChannel())
      throw new Error('did not throw')
    } catch (err) {
      const e = err as Error & { quotaExceeded?: boolean; resetAt?: string }
      expect(e.message).toContain('今日 50 张已用完')
      expect(e.quotaExceeded).toBe(true)
      expect(e.resetAt).toBe('2026-05-16T00:00:00.000Z')
    }
  })

  it('402 insufficient_credits exposes the recharge recovery metadata', async () => {
    const call = await loadCallQueueChannelApi()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { error: 'insufficient_credits', required: 400, available: 250 },
        { status: 402 },
      ),
    )

    try {
      await call(mockOpts({ n: 4 }), mockProfile(), mockChannel())
      throw new Error('did not throw')
    } catch (error) {
      const billingError = error as Error & {
        insufficientCredits?: boolean
        required?: number
        available?: number
      }
      expect(billingError.message).toContain('积分不足')
      expect(billingError.insufficientCredits).toBe(true)
      expect(billingError.required).toBe(400)
      expect(billingError.available).toBe(250)
    }
  })
})
