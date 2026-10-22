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
const { VERTEX_IMAGE_SIZES, VERTEX_MAX_INPUT_IMAGES } = await import('../../lib/upstream/vertex')
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
  models: ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'].map(
    (id) => ({ id, label: id, capabilities: ['generate', 'edit', 'size'] }),
  ),
  defaults: { apiMode: 'images', timeout: 600 },
}

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

  it('raises 512 to 1K on models whose smallest size is 1K', async () => {
    await callUpstream({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      request: { prompt: 'a cup', image_size: '512' },
    })
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: '1K' })
  })

  it('refuses a size the lite model cannot render before calling upstream', async () => {
    const failure = await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: { prompt: 'a cup', image_size: '2K' },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('1K')
    expect((failure as { upstreamStatus?: number }).upstreamStatus).toBe(400)
    expect(calls).toEqual([])
  })

  it('applies the same size rules to an extra.generationConfig imageSize override', async () => {
    const failure = await callUpstream({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
      request: {
        prompt: 'a cup',
        extra: { generationConfig: { imageConfig: { imageSize: '2K' } } },
      },
    }).catch((error: unknown) => error)
    expect((failure as Error).message).toContain('1K')
    expect(calls).toEqual([])

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

describe('Vertex AI size table', () => {
  it('declares the sizes of exactly the models the shipped vertex-images channel offers', () => {
    const shipped = JSON.parse(readFileSync(defaultChannelsPath(), 'utf8')) as {
      channels: { id: string; models: { id: string }[] }[]
    }
    const vertex = shipped.channels.find((channel) => channel.id === 'vertex-images')
    expect(vertex?.models.map((model) => model.id).sort()).toEqual(
      Object.keys(VERTEX_IMAGE_SIZES).sort(),
    )
  })
})
