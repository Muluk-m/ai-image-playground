import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

// Inject before importing config, which captures process environment at module initialization.
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'gateway-key'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const { callUpstream, setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { extractMeta, resolveImageBytesRef } = await import('../../lib/extractImages')
const {
  VERTEX_MAX_INPUT_IMAGES,
  VERTEX_RATE_LIMIT_BACKOFF_MS,
  setVertexRateLimitBackoffForTesting,
} = await import('../../lib/upstream/vertex')
const { channelSlotStateForTesting } = await import('../../lib/upstream/concurrency')
const { extractUpstreamFailure } = await import('../../lib/upstream/errors')
const { isRetryableError } = await import('../../lib/retry')
const { defaultChannelsPath } = await import('../../lib/channels')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>
type FetchCall = { url: string; init: Parameters<TestFetch>[1] }

const BASE = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google'
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

const vertexChannel: InternalChannel = {
  id: 'vertex-images',
  kind: 'gemini-queue',
  label: 'Vertex AI',
  baseUrl: BASE,
  auth: { type: 'bearer', secretRef: 'VERTEX_API_KEY', secret: 'vertex-test-key' },
  allowedPaths: ['models/gemini-nano-banana-2.1:generateContent'],
  models: [
    { id: 'gemini-nano-banana-2.1', imageSizes: ['1K', '2K'] as const },
    { id: 'gemini-3-pro-image', imageSizes: ['1K', '2K'] as const },
    { id: 'gemini-3.1-flash-lite-image', imageSizes: ['1K'] as const },
  ].map(({ id, imageSizes }) => ({
    id,
    label: id,
    capabilities: ['generate', 'edit', 'size'],
    imageSizes: [...imageSizes],
  })),
  defaults: { apiMode: 'images', timeout: 600 },
  modelMaxConcurrency: {
    'gemini-nano-banana-2.1': 2,
    'gemini-3-pro-image': 2,
    'gemini-3.1-flash-lite-image': 2,
  },
}

const PRO_GATE = 'vertex-images/gemini-3-pro-image'

/** 与 2026-10-22 global 端点实测响应同形：图片 part 旁带一大段 thoughtSignature。 */
function vertexResponse(mimeType = 'image/png') {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ inlineData: { mimeType, data: TINY_PNG_B64 }, thoughtSignature: 'sig' }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 34, candidatesTokenCount: 1120 },
    modelVersion: 'gemini-nano-banana-2.1',
  }
}

describe('callUpstream Vertex AI direct channel', () => {
  let calls: FetchCall[] = []

  beforeEach(() => {
    calls = []
    _setChannelsForTesting([vertexChannel])
    setUpstreamFetchForTesting((async (
      input: Parameters<TestFetch>[0],
      init: Parameters<TestFetch>[1],
    ) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify(vertexResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
  })

  afterEach(() => {
    setUpstreamFetchForTesting()
    _setChannelsForTesting([])
  })

  it('posts generateContent to the global publisher root with x-goog-api-key only', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-nano-banana-2.1',
      request: { prompt: '街角咖啡店，招牌写「晨光」', aspect_ratio: '16:9', image_size: '2K' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/models/gemini-nano-banana-2.1:generateContent`)
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('x-goog-api-key')).toBe('vertex-test-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: '街角咖啡店，招牌写「晨光」' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    })
  })

  it('sends reference images as inlineData parts after the prompt', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      request: {
        prompt: '把杯子换成蓝色',
        input_images: [`data:image/png;base64,${TINY_PNG_B64}`, 'data:image/jpeg;base64,AAAA'],
      },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.contents[0].parts).toEqual([
      { text: '把杯子换成蓝色' },
      { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
    ])
  })

  it('raises the shared 512 tier to 1K on models whose smallest size is 1K', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      request: {
        prompt: 'a cup',
        extra: { generationConfig: { imageConfig: { imageSize: '512', aspectRatio: '1:1' } } },
      },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: '1K', aspectRatio: '1:1' })
  })

  it.each([
    ['gemini-3.1-flash-lite-image', '2K', '1K'],
    ['gemini-3.1-flash-lite-image', '512', '1K'],
    ['gemini-3-pro-image', '4K', '2K'],
    ['gemini-nano-banana-2.1', '512', '1K'],
    ['gemini-3.1-flash-lite-image', '8K', '1K'],
  ])('sends %s the nearest declared size instead of %s: %s', async (model, asked, sent) => {
    await callUpstream({
      provider: 'gemini',
      model,
      request: { prompt: 'a cup', image_size: asked },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig.imageConfig.imageSize).toBe(sent)
  })

  it.each([
    ['an unsupported extra override', { generationConfig: { imageConfig: { imageSize: '2K' } } }],
    ['a non-string extra override', { generationConfig: { imageConfig: { imageSize: 2 } } }],
  ])('lowers %s the upstream finally receives to a declared size', async (_case, extra) => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: { prompt: 'a cup', image_size: '1K', extra },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig.imageConfig.imageSize).toBe('1K')
  })

  it.each([
    ['a null imageConfig override', { generationConfig: { imageConfig: null } }],
    ['a string imageConfig override', { generationConfig: { imageConfig: '2K' } }],
  ])('still refuses %s as a malformed config', async (_case, extra) => {
    const failure = await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: { prompt: 'a cup', image_size: '1K', extra },
    }).catch((error: unknown) => error)
    expect((failure as Error).message).toContain('分辨率配置无效')
    expect((failure as { upstreamStatus?: number }).upstreamStatus).toBe(400)
    expect(calls).toEqual([])
  })

  it('accepts a flat size the extra override replaces with a supported one', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: {
        prompt: 'a cup',
        image_size: '2K',
        extra: { generationConfig: { imageConfig: { imageSize: '1K', aspectRatio: '1:1' } } },
      },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: '1K', aspectRatio: '1:1' })
  })

  it(`refuses more than ${VERTEX_MAX_INPUT_IMAGES} reference images before calling upstream`, async () => {
    const input_images = Array.from(
      { length: VERTEX_MAX_INPUT_IMAGES + 1 },
      () => `data:image/png;base64,${TINY_PNG_B64}`,
    )
    await expect(
      callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', input_images },
      }),
    ).rejects.toThrow(`${VERTEX_MAX_INPUT_IMAGES} 张参考图`)
    expect(calls).toEqual([])
  })

  it('fans out n requests and merges every candidate image', async () => {
    const result = await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: { prompt: 'a cup', n: 3 },
    })
    expect(calls).toHaveLength(3)
    expect(extractMeta('gemini', result.payload).images.map((image) => image.index)).toEqual([
      0, 1, 2,
    ])
  })

  describe('multi-image requests', () => {
    let inFlight = 0
    let peak = 0
    let bodies: Array<Record<string, unknown>> = []
    let inFlightByModel = new Map<string, number>()
    let peakByModel = new Map<string, number>()

    /** 每条请求在途一小段时间再回，峰值只取决于渠道上限，与计时快慢无关。 */
    function useSlowUpstream(hold: (signal?: AbortSignal | null) => Promise<void>) {
      inFlight = 0
      peak = 0
      bodies = []
      inFlightByModel = new Map()
      peakByModel = new Map()
      setUpstreamFetchForTesting((async (
        input: Parameters<TestFetch>[0],
        init: Parameters<TestFetch>[1],
      ) => {
        const model = String(input).match(/models\/([^:]+):/)![1]!
        bodies.push(JSON.parse(init?.body as string))
        inFlight += 1
        peak = Math.max(peak, inFlight)
        const mine = (inFlightByModel.get(model) ?? 0) + 1
        inFlightByModel.set(model, mine)
        peakByModel.set(model, Math.max(peakByModel.get(model) ?? 0, mine))
        try {
          await hold(init?.signal)
        } finally {
          inFlight -= 1
          inFlightByModel.set(model, inFlightByModel.get(model)! - 1)
        }
        return new Response(JSON.stringify(vertexResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as TestFetch)
    }

    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    async function waitUntil(ready: () => boolean) {
      for (let attempt = 0; attempt < 400 && !ready(); attempt++) await tick()
    }

    it('splits n into single-image requests with at most two in flight', async () => {
      useSlowUpstream(tick)
      const result = await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', n: 5 },
      })
      expect(bodies).toHaveLength(5)
      for (const body of bodies) {
        expect(body.generationConfig).not.toHaveProperty('candidateCount')
      }
      expect(peak).toBe(2)
      expect(extractMeta('gemini', result.payload).images).toHaveLength(5)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
    })

    it('shares two slots per model across tasks, each model on its own gate', async () => {
      useSlowUpstream(tick)
      await Promise.all([
        callUpstream({
          provider: 'gemini',
          model: 'gemini-3-pro-image',
          request: { prompt: 'a', n: 2 },
        }),
        callUpstream({
          provider: 'gemini',
          model: 'gemini-3-pro-image',
          request: { prompt: 'b', n: 2 },
        }),
        callUpstream({
          provider: 'gemini',
          model: 'gemini-nano-banana-2.1',
          request: { prompt: 'c', n: 3 },
        }),
      ])
      expect(bodies).toHaveLength(7)
      expect(peakByModel.get('gemini-3-pro-image')).toBe(2)
      expect(peakByModel.get('gemini-nano-banana-2.1')).toBe(2)
      // 按模型各算各的：Pro 排满时 2.1 照样能发。
      expect(peak).toBe(4)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
      expect(channelSlotStateForTesting('vertex-images')).toEqual({ active: 0, waiting: 0 })
    })

    it('gives a queued request up on cancel without taking a slot', async () => {
      let releaseFirst = () => {}
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      useSlowUpstream(() => held)
      const running = callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a', n: 2 },
      })
      const controller = new AbortController()
      const queued = callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'b' },
        signal: controller.signal,
      }).catch((error: unknown) => error)
      await waitUntil(() => inFlight === 2 && channelSlotStateForTesting(PRO_GATE).waiting === 1)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 2, waiting: 1 })
      controller.abort()
      expect(await queued).toBeInstanceOf(Error)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 2, waiting: 0 })
      releaseFirst()
      await running
      expect(bodies).toHaveLength(2)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
    })

    it('refuses a candidateCount override, which Vertex answers with 400', async () => {
      const failure = await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', extra: { generationConfig: { candidateCount: 2 } } },
      }).catch((error: unknown) => error)
      expect((failure as { upstreamStatus?: number }).upstreamStatus).toBe(400)
      expect(calls).toEqual([])
    })
  })

  describe('rate limiting (429)', () => {
    let attempts: string[] = []

    /** 按顺序回放状态码；放完一律 200。429 体与 2026-10-22 实测同形。 */
    function useStatuses(statuses: number[]) {
      attempts = []
      const queue = [...statuses]
      setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0]) => {
        attempts.push(String(input))
        const status = queue.shift() ?? 200
        if (status === 200)
          return new Response(JSON.stringify(vertexResponse()), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        return new Response(
          JSON.stringify({
            error: {
              code: status,
              message:
                status === 429
                  ? 'Resource has been exhausted (e.g. check quota).'
                  : 'Request contains an invalid argument.',
              status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT',
            },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as TestFetch)
    }

    beforeEach(() => setVertexRateLimitBackoffForTesting([1, 1, 1]))
    afterEach(() => setVertexRateLimitBackoffForTesting())

    it('backs off and resends inside the request until Vertex accepts it', async () => {
      useStatuses([429, 429])
      const result = await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup' },
      })
      expect(attempts).toHaveLength(3)
      expect(extractMeta('gemini', result.payload).images).toHaveLength(1)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
    })

    it('keeps the images that already came back when one fan-out request is throttled', async () => {
      useStatuses([200, 429])
      const result = await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', n: 2 },
      })
      // 两条各发一次，只有被 429 的那条重发：已出的图不重做。
      expect(attempts).toHaveLength(3)
      expect(extractMeta('gemini', result.payload).images).toHaveLength(2)
    })

    it('gives up after the backoff with a retryable, plainly worded 429', async () => {
      useStatuses([429, 429, 429, 429, 429])
      const failure = (await callUpstream({
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite-image',
        request: { prompt: 'a cup' },
      }).catch((error: unknown) => error)) as Error & { upstreamStatus?: number }
      expect(attempts).toHaveLength(1 + VERTEX_RATE_LIMIT_BACKOFF_MS.length)
      expect(failure.upstreamStatus).toBe(429)
      expect(failure.message).toContain('上游限流')
      expect(failure.message).not.toContain('check quota')
      expect(extractUpstreamFailure(failure)).toEqual({
        status: 429,
        body: expect.stringContaining('RESOURCE_EXHAUSTED'),
      })
    })

    it('does not let the task retry regenerate a group whose other images already came back', async () => {
      // 一条出图，另一条首发 + 3 次退避全是 429。
      useStatuses([200, 429, 429, 429, 429])
      const failure = (await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', n: 2 },
      }).catch((error: unknown) => error)) as Error & { upstreamStatus?: number }
      expect(attempts).toHaveLength(2 + VERTEX_RATE_LIMIT_BACKOFF_MS.length)
      expect(failure.upstreamStatus).toBe(429)
      expect(isRetryableError(failure)).toBe(false)
      expect(failure.message).toContain('上游限流')
      expect(failure.message).toContain('不再自动重跑')
      expect(failure.message).not.toContain('Nano Banana')
      expect(extractUpstreamFailure(failure)).toEqual({
        status: 429,
        body: expect.stringContaining('RESOURCE_EXHAUSTED'),
      })
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
    })

    it('leaves the task retry in charge when no image of the group came back', async () => {
      useStatuses(Array.from({ length: 2 * (1 + VERTEX_RATE_LIMIT_BACKOFF_MS.length) }, () => 429))
      const failure = (await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup', n: 2 },
      }).catch((error: unknown) => error)) as Error & { upstreamStatus?: number }
      expect(failure.upstreamStatus).toBe(429)
      expect(isRetryableError(failure)).toBe(true)
      expect(failure.message).not.toContain('不再自动重跑')
    })

    it('does not resend other upstream errors', async () => {
      useStatuses([400])
      const failure = (await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup' },
      }).catch((error: unknown) => error)) as Error & { upstreamStatus?: number }
      expect(attempts).toHaveLength(1)
      expect(failure.upstreamStatus).toBe(400)
    })

    it('stops backing off on cancel and reports the cancel, not a 429', async () => {
      setVertexRateLimitBackoffForTesting([60_000])
      useStatuses([429])
      const controller = new AbortController()
      const pending = callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'a cup' },
        signal: controller.signal,
      }).catch((error: unknown) => error)
      for (let i = 0; i < 200 && attempts.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      controller.abort()
      const failure = (await pending) as Error & { upstreamStatus?: number }
      expect(failure).toBeInstanceOf(Error)
      expect(failure.upstreamStatus).toBeUndefined()
      expect(attempts).toHaveLength(1)
      expect(channelSlotStateForTesting(PRO_GATE)).toEqual({ active: 0, waiting: 0 })
    })
  })

  it('leaves non-Vertex Gemini models on the gateway with its own header', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      request: { prompt: 'a cup', image_size: '512' },
    })
    expect(calls[0]!.url).toBe(
      'http://localhost:9999/v1beta/models/gemini-3.1-flash-image:generateContent',
    )
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit)
    expect(headers.get('x-api-key')).toBe('gateway-key')
    expect(headers.get('x-goog-api-key')).toBeNull()
    expect(JSON.parse(calls[0]!.init?.body as string).generationConfig.imageConfig).toEqual({
      imageSize: '512',
    })
  })
})

describe('Vertex AI response parsing', () => {
  it('reads the image from candidates[].content.parts[].inlineData and ignores thoughtSignature', () => {
    const payload = vertexResponse('image/jpeg')
    expect(extractMeta('gemini', payload).images).toEqual([
      { index: 0, mime: 'image/jpeg', revised_prompt: undefined },
    ])
    expect(resolveImageBytesRef('gemini', payload, 0)).toEqual({
      kind: 'b64',
      data: TINY_PNG_B64,
      mime: 'image/jpeg',
    })
    expect(resolveImageBytesRef('gemini', payload, 1)).toBeNull()
  })
})

describe('Vertex AI size declarations', () => {
  it('declares the sizes each shipped Vertex model renders, without 512 or the unpriced 4K', () => {
    const shipped = JSON.parse(readFileSync(defaultChannelsPath(), 'utf8')) as {
      channels: { id: string; models: { id: string; imageSizes?: string[] }[] }[]
    }
    const vertex = shipped.channels.find((channel) => channel.id === 'vertex-images')
    // 2026-10-22 global 端点实测：512 三个模型都 400，Lite 只出 1K。
    expect(Object.fromEntries(vertex!.models.map((model) => [model.id, model.imageSizes]))).toEqual(
      {
        'gemini-nano-banana-2.1': ['1K', '2K'],
        'gemini-3-pro-image': ['1K', '2K'],
        'gemini-3.1-flash-lite-image': ['1K'],
      },
    )
  })
})
