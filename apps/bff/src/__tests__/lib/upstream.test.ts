import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Buffer, File } from 'node:buffer'
import sharp from 'sharp'
import { FormData as UndiciFormData } from 'undici'

// Inject before importing config, which captures process environment at module initialization.
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const {
  callUpstream,
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

async function solidImageDataUrl(
  color: string,
  format: 'png' | 'jpeg' = 'png',
): Promise<{ bytes: Buffer; dataUrl: string }> {
  const image = sharp({
    create: { width: 80, height: 80, channels: 4, background: color },
  })
  const bytes = format === 'jpeg' ? await image.jpeg().toBuffer() : await image.png().toBuffer()
  const mime = `image/${format}`
  return { bytes, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

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
    expect(parsed.response_format).toBeUndefined()
  })

  it('records every dispatch when OpenAI fans out the requested image count', async () => {
    let dispatches = 0
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat', n: 4 },
      beforeRequest: async () => {
        dispatches += 1
      },
    })
    expect(dispatches).toBe(4)
  })

  it('starts the accounted request before applying a concurrent cancellation', async () => {
    const controller = new AbortController()

    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat' },
      signal: controller.signal,
      beforeRequest: async () => {
        controller.abort()
      },
    }).catch(() => undefined)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.signal?.aborted).toBe(true)
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
    expect(form.get('response_format')).toBeNull()
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

  it('generic OpenAI with multiple input_images keeps one original multipart file per input', async () => {
    const red = await solidImageDataUrl('#ff0000')
    const blue = await solidImageDataUrl('#0000ff')
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'merge these',
        input_images: [red.dataUrl, blue.dataUrl],
      },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as UndiciFormData
    const images = form.getAll('image[]') as File[]
    expect(images).toHaveLength(2)
    expect(Buffer.from(await images[0]!.arrayBuffer()).equals(red.bytes)).toBe(true)
    expect(Buffer.from(await images[1]!.arrayBuffer()).equals(blue.bytes)).toBe(true)
  })

  it('keeps the existing invalid data URL error on the multipart edits path', async () => {
    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'gpt-image-2',
        request: { prompt: 'edit', input_images: ['not-a-data-url'] },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      'input_images 中的数据 URL 格式无效，必须是 data:<mime>;base64,<...>',
    )
    expect(calls).toHaveLength(0)
  })

  it('fans out OpenAI edits without forwarding n into the upstream image tool', async () => {
    setUpstreamFetchForTesting((async (
      input: Parameters<TestFetch>[0],
      init: Parameters<TestFetch>[1],
    ) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      const form = init?.body as UndiciFormData
      if (form.get('n') !== null) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Unknown parameter: 'tools[0].n'.",
              param: 'tools[0].n',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ data: [{ b64_json: `ok-${calls.length}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'edit',
        n: 3,
        input_images: [TINY_PNG_DATA_URL],
        extra: { n: 99, strength: 0.5 },
      },
    })

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      const form = call.init?.body as UndiciFormData
      expect(form.get('n')).toBeNull()
      expect(form.get('strength')).toBe('0.5')
    }
    expect(result.payload).toMatchObject({
      data: [{ b64_json: 'ok-1' }, { b64_json: 'ok-2' }, { b64_json: 'ok-3' }],
    })
  })

  it('without input_images and n>1: sends one generation request per image and omits n', async () => {
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'generate', n: 2 },
    })
    const payload = result.payload as { data: unknown[] }
    expect(payload.data).toHaveLength(2)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toMatch(/\/v1\/images\/generations$/)
      expect(JSON.parse(call.init?.body as string).n).toBeUndefined()
    }
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

describe('callUpstream 独立直连 channel 路由（CHANNEL_ROUTE_STYLES）', () => {
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

  it('records every Gemini fan-out request at dispatch time', async () => {
    let dispatches = 0
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      request: { prompt: 'a cat', n: 4 },
      beforeRequest: async () => {
        dispatches += 1
      },
    })
    expect(dispatches).toBe(4)
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

  it('带 mask：在请求记账前立即永久失败（upstreamStatus=400 不触发重试）', async () => {
    let caught: (Error & { upstreamStatus?: number }) | null = null
    let dispatches = 0
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'agnes-image-2.1-flash',
        request: { prompt: 'edit', input_images: [TINY_PNG_DATA_URL], mask: TINY_PNG_DATA_URL },
        beforeRequest: async () => {
          dispatches += 1
        },
      })
    } catch (err) {
      caught = err as Error & { upstreamStatus?: number }
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('遮罩')
    expect(caught!.upstreamStatus).toBe(400)
    expect(dispatches).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('n=3：fan-out 3 次并发请求并合并 data（上游忽略 n 参数）', async () => {
    let dispatches = 0
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'agnes-image-2.1-flash',
      request: { prompt: 'a star', n: 3 },
      beforeRequest: async () => {
        dispatches += 1
      },
    })
    expect(calls).toHaveLength(3)
    expect(dispatches).toBe(3)
    for (const c of calls) {
      const body = JSON.parse(c.init?.body as string)
      expect(body.n).toBeUndefined()
    }
    const payload = result.payload as { data: unknown[] }
    expect(payload.data).toHaveLength(3)
  })
})

describe('callUpstream grok-images channel（channel base/key + 标准 OpenAI 协议）', () => {
  let calls: FetchCall[] = []

  const grokChannel: InternalChannel = {
    id: 'grok-images',
    kind: 'openai-queue',
    label: 'Grok Imagine Image',
    baseUrl: 'https://sub2api.qiliangjia.org/v1',
    auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'grok-test-key' },
    allowedPaths: ['images/generations', 'images/edits'],
    models: [
      {
        id: 'grok-imagine-image',
        label: 'Grok Imagine Image',
        capabilities: ['generate', 'edit', 'n'],
      },
    ],
    defaults: { apiMode: 'images', timeout: 600, responseFormatB64Json: true },
  }

  beforeEach(() => {
    calls = []
    _setChannelsForTesting([grokChannel])
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

  it('generations：走 channel baseUrl + Bearer channel key + 标准 JSON 体', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: { prompt: 'a cat', size: '1024x1024' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://sub2api.qiliangjia.org/v1/images/generations')
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer grok-test-key')
    expect(headers.get('content-type')).toContain('application/json')
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body).toMatchObject({
      model: 'grok-imagine-image',
      prompt: 'a cat',
      size: '1024x1024',
      response_format: 'b64_json',
    })
    // 标准 OpenAI 语义：不走 Agnes 私有的 extra_body.image 协议
    expect(body.extra_body).toBeUndefined()
  })

  it('generations：剥掉 moderation（上游带上必 403）', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: { prompt: 'a cat', moderation: 'auto', output_format: 'png' },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body).not.toHaveProperty('moderation')
    expect(body.output_format).toBe('png')
  })

  it('edits：剥掉 moderation（上游带上必 403）', async () => {
    const original = await solidImageDataUrl('#cc5500', 'jpeg')
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: {
        prompt: 'make it blue',
        input_images: [original.dataUrl],
        moderation: 'low',
        output_format: 'png',
      },
    })
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.get('moderation')).toBeNull()
    expect(form.get('output_format')).toBe('png')
  })

  it('generations：channel 声明 responseFormatB64Json 时压过 extra 的 response_format', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: { prompt: 'a cat', extra: { response_format: 'url' } },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.response_format).toBe('b64_json')
  })

  it('edits：multipart 只带一个 response_format=b64_json，不留 extra 的同名残余', async () => {
    const original = await solidImageDataUrl('#cc5500', 'jpeg')
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: {
        prompt: 'make it blue',
        input_images: [original.dataUrl],
        extra: { response_format: 'url' },
      },
    })
    const form = calls[0]!.init?.body as UndiciFormData
    expect(form.getAll('response_format')).toEqual(['b64_json'])
  })

  it('edits：单张 input image 作为一个原始 multipart 文件透传', async () => {
    const original = await solidImageDataUrl('#cc5500', 'jpeg')
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: {
        prompt: 'make it blue',
        size: '1024x1024',
        input_images: [original.dataUrl],
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://sub2api.qiliangjia.org/v1/images/edits')
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer grok-test-key')
    const body = calls[0]!.init?.body
    expect(body).toBeInstanceOf(UndiciFormData)
    const form = body as UndiciFormData
    expect(form.get('model')).toBe('grok-imagine-image')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('size')).toBe('1024x1024')
    const images = form.getAll('image[]')
    expect(images).toHaveLength(1)
    expect(images[0]).toBeInstanceOf(File)
    const passthrough = images[0] as File
    expect(passthrough.type).toBe('image/jpeg')
    expect(Buffer.from(await passthrough.arrayBuffer()).equals(original.bytes)).toBe(true)
  })

  it('edits：两张 input image 合成一个有序标签、尺寸有界的 PNG contact sheet', async () => {
    const red = await solidImageDataUrl('#ff0000')
    const blue = await solidImageDataUrl('#0000ff')
    // 与 upstream.ts 的 GROK_CONTACT_SHEET_* 常量对齐（未导出，这里显式复刻）。
    const maxSide = 2048
    const gap = 16
    const labelHeight = 64
    await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: {
        prompt: 'put the red reference before the blue reference',
        input_images: [red.dataUrl, blue.dataUrl],
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://sub2api.qiliangjia.org/v1/images/edits')
    const form = calls[0]!.init?.body as UndiciFormData
    const images = form.getAll('image[]')
    expect(images).toHaveLength(1)
    const contactSheetFile = images[0] as File
    expect(contactSheetFile.type).toBe('image/png')
    const contactSheet = Buffer.from(await contactSheetFile.arrayBuffer())
    const metadata = await sharp(contactSheet).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.width).toBeGreaterThan(0)
    expect(metadata.height).toBeGreaterThan(0)
    expect(metadata.width).toBeLessThanOrEqual(maxSide)
    expect(metadata.height).toBeLessThanOrEqual(maxSide)

    const { data: pixels, info } = await sharp(contactSheet)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    function pixelAt(x: number, y: number): number[] {
      const offset = (y * info.width + x) * info.channels
      return Array.from(pixels.subarray(offset, offset + 3))
    }
    // 两个正方形 tile 横向排列：左红右蓝，证明输入顺序没有反转。
    expect(pixelAt(Math.floor(info.width / 4), Math.floor(info.height / 3))).toEqual([255, 0, 0])
    expect(pixelAt(Math.floor((info.width * 3) / 4), Math.floor(info.height / 3))).toEqual([
      0, 0, 255,
    ])
    // 每个 tile 底部都有深色 label strip，且白色标签文本确实被渲染。
    const labelWidth = Math.floor((info.width - gap) / 2)
    for (const left of [0, info.width - labelWidth]) {
      const stats = await sharp(contactSheet)
        .extract({ left, top: info.height - labelHeight, width: labelWidth, height: labelHeight })
        .stats()
      expect(stats.channels[0]!.min).toBeLessThan(50)
      expect(stats.channels[0]!.max).toBeGreaterThan(200)
    }
  })

  it('预先取消时在 Grok contact-sheet 预处理前终止，不发起 fetch', async () => {
    const abort = new AbortController()
    abort.abort()
    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'grok-imagine-image',
        request: {
          prompt: 'merge these',
          input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
        },
        signal: abort.signal,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AbortError')
    expect(calls).toHaveLength(0)
  })

  it('Grok contact sheet 超过 16 张输入时明确拒绝，不发起 fetch', async () => {
    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'grok-imagine-image',
        request: {
          prompt: 'merge these',
          input_images: Array.from({ length: 17 }, () => TINY_PNG_DATA_URL),
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('最多支持 16 张参考图')
    expect(calls).toHaveLength(0)
  })

  it('Grok 多张输入与 mask 组合时明确拒绝，不发起 fetch', async () => {
    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'grok-imagine-image',
        request: {
          prompt: 'mask these',
          input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
          mask: TINY_PNG_DATA_URL,
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('不支持“多张参考图 + 遮罩”')
    expect((caught as Error).message).toContain('遮罩坐标无法映射到 contact sheet')
    expect(calls).toHaveLength(0)
  })

  it('多图 normalizer 保留无效 data URL 的原有错误', async () => {
    let caught: unknown
    try {
      await callUpstream({
        provider: 'openai-compat',
        model: 'grok-imagine-image',
        request: {
          prompt: 'merge these',
          input_images: ['not-a-data-url', TINY_PNG_DATA_URL],
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      'input_images 中的数据 URL 格式无效，必须是 data:<mime>;base64,<...>',
    )
    expect(calls).toHaveLength(0)
  })

  it('n=2：fan-out 两次 generations 请求（体不带 n）并合并 data 成长度 2', async () => {
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: { prompt: 'a star', n: 2 },
    })
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.url).toBe('https://sub2api.qiliangjia.org/v1/images/generations')
      const headers = new Headers(c.init?.headers as HeadersInit)
      expect(headers.get('authorization')).toBe('Bearer grok-test-key')
      expect(JSON.parse(c.init?.body as string).n).toBeUndefined()
    }
    const payload = result.payload as { data: unknown[] }
    expect(payload.data).toHaveLength(2)
  })

  it('n=2 + 两张编辑输入：fan-out 两次 multipart，每次只有一张 contact sheet', async () => {
    const red = await solidImageDataUrl('#ff0000')
    const blue = await solidImageDataUrl('#0000ff')
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'grok-imagine-image',
      request: {
        prompt: 'merge these',
        n: 2,
        input_images: [red.dataUrl, blue.dataUrl],
      },
    })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe('https://sub2api.qiliangjia.org/v1/images/edits')
      const form = call.init?.body as UndiciFormData
      expect(form.get('n')).toBeNull()
      const images = form.getAll('image[]')
      expect(images).toHaveLength(1)
      expect(images[0]).toBeInstanceOf(File)
      const contactSheet = images[0] as File
      expect(contactSheet.type).toBe('image/png')
      const metadata = await sharp(Buffer.from(await contactSheet.arrayBuffer())).metadata()
      expect(metadata.format).toBe('png')
    }
    expect((result.payload as { data: unknown[] }).data).toHaveLength(2)
  })
})
