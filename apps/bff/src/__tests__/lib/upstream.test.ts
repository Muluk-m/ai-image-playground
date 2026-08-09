import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { File } from 'node:buffer'
import { FormData as UndiciFormData } from 'undici'

// Inject before importing config, which captures process environment at module initialization.
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const {
  callUpstream,
  upstreamInvocationCount,
  setUpstreamFetchForTesting,
  UPSTREAM_TRANSPORT_TIMEOUT_MS,
  UpstreamResultUnknownError,
} = await import('../../lib/upstream')
const { _setChannelsForTesting } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

// 1x1 透明 PNG 的 base64
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`

type FetchCall = { url: string; init: Parameters<TestFetch>[1] }

describe('callUpstream OpenAI route', () => {
  let calls: FetchCall[] = []

  beforeEach(() => {
    calls = []
    setUpstreamFetchForTesting((async (
      input: Parameters<TestFetch>[0],
      init: Parameters<TestFetch>[1],
    ) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify({ data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
  })

  it('without input_images: hits /v1/images/generations with JSON body', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat', size: '1024x1024' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/generations$/)
    const body = calls[0]!.init?.body
    expect(typeof body).toBe('string')
    const parsed = JSON.parse(body as string)
    expect(parsed).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024' })
  })

  it('counts one OpenAI HTTP invocation when n is forwarded in one request', () => {
    expect(upstreamInvocationCount('openai-compat', 'gpt-image-2', { prompt: 'a cat', n: 4 })).toBe(
      1,
    )
  })

  it('forwards OpenAI output controls in the generations JSON body', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'a cat',
        output_format: 'webp',
        moderation: 'low',
        output_compression: 75,
      },
    })
    const parsed = JSON.parse(calls[0]!.init?.body as string)
    expect(parsed).toMatchObject({
      output_format: 'webp',
      moderation: 'low',
      output_compression: 75,
    })
  })

  it('preserves output_compression=0 in the generations JSON body', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat', output_format: 'webp', output_compression: 0 },
    })
    const parsed = JSON.parse(calls[0]!.init?.body as string)
    expect(parsed.output_compression).toBe(0)
  })

  it('with input_images: hits /v1/images/edits with multipart FormData containing image[]', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'turn this cat into a dog',
        size: '1024x1024',
        input_images: [TINY_PNG_DATA_URL],
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const body = calls[0]!.init?.body
    // multipart FormData，不是 JSON
    expect(body).toBeInstanceOf(UndiciFormData)
    const form = body as UndiciFormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('turn this cat into a dog')
    expect(form.get('size')).toBe('1024x1024')
    // image[] 必须以 Blob/File 形式存在，且字节数 > 0
    const images = form.getAll('image[]')
    expect(images).toHaveLength(1)
    const file = images[0]
    expect(file).toBeInstanceOf(File)
    expect((file as File).size).toBeGreaterThan(0)
  })

  it('forwards OpenAI output controls in the edits multipart body', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'edit',
        input_images: [TINY_PNG_DATA_URL],
        output_format: 'jpeg',
        moderation: 'auto',
        output_compression: 0,
      },
    })
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.get('output_format')).toBe('jpeg')
    expect(form.get('moderation')).toBe('auto')
    expect(form.get('output_compression')).toBe('0')
  })

  it('with multiple input_images: appends one image[] entry per data URL', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'merge these',
        input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.getAll('image[]')).toHaveLength(3)
  })

  it('with input_images and n>1: forwards n via FormData field', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'edit',
        n: 3,
        input_images: [TINY_PNG_DATA_URL],
      },
    })
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.get('n')).toBe('3')
  })

  it('with mask: appends mask Blob alongside image[] in FormData', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'mask edit',
        input_images: [TINY_PNG_DATA_URL],
        mask: TINY_PNG_DATA_URL,
      },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.getAll('image[]')).toHaveLength(1)
    const mask = form.get('mask')
    expect(mask).toBeInstanceOf(File)
    expect((mask as File).size).toBeGreaterThan(0)
  })

  it('with mask but no input_images: still hits /v1/images/edits', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'edit', mask: TINY_PNG_DATA_URL },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.get('mask')).toBeInstanceOf(File)
  })

  it('preserves Bearer authorization header on edits path', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'edit', input_images: [TINY_PNG_DATA_URL] },
    })
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    // multipart Content-Type 必须由 fetch / FormData 自己生成（含 boundary），不能手填 application/json
    const ct = headers.get('content-type')
    expect(ct === null || ct.startsWith('multipart/form-data')).toBe(true)
  })

  it('uses an explicit dispatcher whose transport timeout exceeds the application deadline', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat' },
    })
    expect(calls[0]!.init?.dispatcher).toBeDefined()
    expect(UPSTREAM_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(15 * 60 * 1000)
  })

  it('classifies an interrupted response body as an unknown upstream result', async () => {
    setUpstreamFetchForTesting((async () => {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new TypeError('terminated')
        },
      }
    }) as unknown as TestFetch)

    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'gpt-image-2',
        request: { prompt: 'a cat' },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UpstreamResultUnknownError)
    expect((caught as Error).message).toContain('上游响应中断')
  })
})

describe('callUpstream direct channel 路由（DIRECT_CHANNEL_IDS）', () => {
  let calls: FetchCall[] = []

  const agnesChannel: InternalChannel = {
    id: 'agnes-images',
    kind: 'openai-queue',
    label: 'Agnes AI',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    auth: { type: 'bearer', secretRef: 'AGNES_API_KEY', secret: 'agnes-test-key' },
    allowedPaths: ['images/generations'],
    models: [
      { id: 'agnes-image-2.1-flash', label: 'Agnes Image 2.1 Flash', capabilities: ['generate'] },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  beforeEach(() => {
    calls = []
    _setChannelsForTesting([agnesChannel])
    setUpstreamFetchForTesting((async (
      input: Parameters<TestFetch>[0],
      init: Parameters<TestFetch>[1],
    ) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify({ data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    _setChannelsForTesting([])
  })

  it('agnes 模型走 channel baseUrl + 相对路径，不再拼出 /v1/v1（双 /v1 事故回归）', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'agnes-image-2.1-flash',
      request: { prompt: 'a cat', size: '1024x1024' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://apihub.agnes-ai.com/v1/images/generations')
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer agnes-test-key')
  })

  it('非 direct 模型仍走 UPSTREAM_BASE_URL 网关（行为不变）', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat' },
    })
    expect(calls[0]!.url).toBe('http://localhost:9999/v1/images/generations')
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer test-key')
  })

  it('gemini 仍走网关 /v1beta 并带 x-api-key（不受 direct channel 影响）', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      request: { prompt: 'a cat' },
    })
    expect(calls[0]!.url).toBe(
      'http://localhost:9999/v1beta/models/gemini-3.1-flash-image:generateContent',
    )
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('x-api-key')).toBe('test-key')
    expect(headers.get('authorization')).toBeNull()
  })

  it('gemini 请求透传 imageConfig 与 thinkingConfig', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      request: {
        prompt: 'a cat',
        aspect_ratio: '16:9',
        image_size: '2K',
        thinking_level: 'high',
      },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig).toMatchObject({
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      thinkingConfig: { thinkingLevel: 'high' },
    })
  })

  it('counts every Gemini fan-out request', () => {
    expect(
      upstreamInvocationCount('gemini', 'gemini-3.1-flash-image', {
        prompt: 'a cat',
        n: 4,
      }),
    ).toBe(4)
  })

  it('gemini extra.generationConfig 保持最终覆盖优先级', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      request: {
        prompt: 'a cat',
        aspect_ratio: '16:9',
        image_size: '2K',
        thinking_level: 'high',
        extra: {
          generationConfig: {
            imageConfig: { aspectRatio: '1:1', imageSize: '512' },
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        },
      },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig).toMatchObject({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '512' },
      thinkingConfig: { thinkingLevel: 'minimal' },
    })
  })
})

describe('callUpstream direct channel 图生图（Agnes 风格 generations JSON）', () => {
  let calls: FetchCall[] = []

  const agnesChannel: InternalChannel = {
    id: 'agnes-images',
    kind: 'openai-queue',
    label: 'Agnes AI',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    auth: { type: 'bearer', secretRef: 'AGNES_API_KEY', secret: 'agnes-test-key' },
    allowedPaths: ['images/generations'],
    models: [
      {
        id: 'agnes-image-2.1-flash',
        label: 'Agnes Image 2.1 Flash',
        capabilities: ['generate', 'edit'],
      },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  beforeEach(() => {
    calls = []
    _setChannelsForTesting([agnesChannel])
    setUpstreamFetchForTesting((async (
      input: Parameters<TestFetch>[0],
      init: Parameters<TestFetch>[1],
    ) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example/x.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    _setChannelsForTesting([])
  })

  it('带 input_images：仍走 generations JSON，图放 extra_body.image（无 edits multipart）', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'agnes-image-2.1-flash',
      request: {
        prompt: 'make it blue',
        size: '1024x1024',
        input_images: [TINY_PNG_DATA_URL],
        output_format: 'webp',
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://apihub.agnes-ai.com/v1/images/generations')
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.extra_body.image).toEqual([TINY_PNG_DATA_URL])
    // 上游会静默忽略 top-level image / quality / n，确保没传
    expect(body.image).toBeUndefined()
    expect(body.quality).toBeUndefined()
    expect(body.output_format).toBeUndefined()
    expect(body.n).toBeUndefined()
  })

  it('带 mask：立即永久失败（upstreamStatus=400 不触发重试）', async () => {
    let caught: (Error & { upstreamStatus?: number }) | null = null
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'agnes-image-2.1-flash',
        request: { prompt: 'edit', input_images: [TINY_PNG_DATA_URL], mask: TINY_PNG_DATA_URL },
      })
    } catch (err) {
      caught = err as Error & { upstreamStatus?: number }
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('遮罩')
    expect(caught!.upstreamStatus).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('n=3：fan-out 3 次并发请求并合并 data（上游忽略 n 参数）', async () => {
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'agnes-image-2.1-flash',
      request: { prompt: 'a star', n: 3 },
    })
    expect(calls).toHaveLength(3)
    expect(
      upstreamInvocationCount('openai-compat', 'agnes-image-2.1-flash', {
        prompt: 'a star',
        n: 3,
      }),
    ).toBe(3)
    for (const c of calls) {
      const body = JSON.parse(c.init?.body as string)
      expect(body.n).toBeUndefined()
    }
    const payload = result.payload as { data: unknown[] }
    expect(payload.data).toHaveLength(3)
  })
})
