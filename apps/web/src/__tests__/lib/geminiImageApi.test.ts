import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../lib/apiProfiles'
import {
  buildGeminiRequestBody,
  callGeminiImageApi,
  parseGeminiResponse,
} from '../../lib/geminiImageApi'
import type { BYOKAdapterProfile } from '../../lib/imageApiShared'
import { DEFAULT_PARAMS } from '../../types'

function byokGemini(overrides: Partial<BYOKAdapterProfile> = {}): BYOKAdapterProfile {
  return {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gk',
    model: 'gemini-3.1-flash-image',
    apiMode: 'images',
    timeout: 600,
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}

describe('buildGeminiRequestBody', () => {
  it('builds text-only request', () => {
    const body = buildGeminiRequestBody({
      prompt: 'a cat',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
    })
    expect(body.contents[0].parts).toEqual([{ text: 'a cat' }])
    expect(body.generationConfig?.imageConfig).toBeUndefined()
    expect(body.generationConfig?.candidateCount).toBeUndefined()
    expect(body.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE'])
  })

  it('attaches inlineData parts for reference images', () => {
    const png1 = 'data:image/png;base64,AAA'
    const png2 = 'data:image/jpeg;base64,BBB'
    const body = buildGeminiRequestBody({
      prompt: 'edit it',
      inputImageDataUrls: [png1, png2],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
    })
    expect(body.contents[0].parts).toEqual([
      { text: 'edit it' },
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBB' } },
    ])
  })

  it('maps 1024x1024 to aspectRatio 1:1', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '1:1' })
  })

  it('maps 1536x1024 (ratio 1.5) to 4:3', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1536x1024' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '4:3' })
  })

  it('maps 1920x1080 (16:9) to 16:9', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1920x1080' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '16:9' })
  })

  it('prefers explicit gemini_aspect_ratio over size-based guess', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1024x1024', gemini_aspect_ratio: '21:9' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '21:9' })
  })

  it('emits imageSize when gemini_image_size set', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', gemini_image_size: '2K' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ imageSize: '2K' })
  })

  it('emits both aspectRatio and imageSize together', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: {
        ...DEFAULT_PARAMS,
        size: 'auto',
        gemini_aspect_ratio: '16:9',
        gemini_image_size: '4K',
      },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '4K' })
  })

  it('emits thinkingConfig only when gemini_thinking_level set', () => {
    const without = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto' },
    })
    expect(without.generationConfig?.thinkingConfig).toBeUndefined()

    const high = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', gemini_thinking_level: 'high' },
    })
    expect(high.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'high' })
  })

  it('never sets candidateCount (Gemini image gen forbids candidateCount>1)', () => {
    // n>1 由 callGeminiImageApi 外层 fan-out 实现，body 永远是单 candidate。
    const single = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
    })
    expect(single.generationConfig?.candidateCount).toBeUndefined()

    const multi = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 3 },
    })
    expect(multi.generationConfig?.candidateCount).toBeUndefined()
  })
})

describe('parseGeminiResponse', () => {
  it('extracts inline image and revised prompt from one candidate', () => {
    const result = parseGeminiResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: 'here is the cat' },
              { inlineData: { mimeType: 'image/png', data: 'AAA' } },
            ],
          },
        },
      ],
    })
    expect(result.images).toEqual(['data:image/png;base64,AAA'])
    expect(result.revisedPrompts).toEqual(['here is the cat'])
  })

  it('extracts multiple images across candidates', () => {
    const result = parseGeminiResponse({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
        { content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'BBB' } }] } },
      ],
    })
    expect(result.images).toEqual(['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB'])
  })

  it('throws when no candidates contain image parts', () => {
    expect(() =>
      parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] }),
    ).toThrow(/Gemini.*未返回可用图片/)
  })

  it('throws on empty candidates array', () => {
    expect(() => parseGeminiResponse({ candidates: [] })).toThrow(/Gemini.*未返回可用图片/)
  })

  it('attaches rawResponsePayload on parse failure', () => {
    try {
      parseGeminiResponse({ candidates: [] })
      throw new Error('should not reach here')
    } catch (err) {
      expect((err as { rawResponsePayload?: string }).rawResponsePayload).toContain('"candidates"')
    }
  })
})

describe('callGeminiImageApi', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('POSTs to {baseUrl}/models/{model}:generateContent with x-api-key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
          ],
        }),
        { status: 200 },
      ),
    )

    await callGeminiImageApi(
      {
        settings: DEFAULT_SETTINGS,
        prompt: 'p',
        params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
        inputImageDataUrls: [],
      },
      byokGemini({ model: 'gemini-3.1-flash-image', baseUrl: 'https://gen.example/v1beta' }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gen.example/v1beta/models/gemini-3.1-flash-image:generateContent')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('gk')
    expect(headers['x-goog-api-key']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns images array via parseGeminiResponse', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
          ],
        }),
        { status: 200 },
      ),
    )

    const result = await callGeminiImageApi(
      {
        settings: DEFAULT_SETTINGS,
        prompt: 'p',
        params: { ...DEFAULT_PARAMS, n: 1 },
        inputImageDataUrls: [],
      },
      byokGemini(),
    )

    expect(result.images).toEqual(['data:image/png;base64,AAA'])
  })

  it('rejects mask input with explicit error', async () => {
    await expect(
      callGeminiImageApi(
        {
          settings: DEFAULT_SETTINGS,
          prompt: 'p',
          params: { ...DEFAULT_PARAMS },
          inputImageDataUrls: ['data:image/png;base64,AAA'],
          maskDataUrl: 'data:image/png;base64,MMM',
        },
        byokGemini(),
      ),
    ).rejects.toThrow(/不支持遮罩/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fans out into N parallel single-candidate requests when n>1', async () => {
    const mkRes = (data: string) =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }],
        }),
        { status: 200 },
      )
    fetchMock
      .mockResolvedValueOnce(mkRes('AAA'))
      .mockResolvedValueOnce(mkRes('BBB'))
      .mockResolvedValueOnce(mkRes('CCC'))

    const result = await callGeminiImageApi(
      {
        settings: DEFAULT_SETTINGS,
        prompt: 'p',
        params: { ...DEFAULT_PARAMS, n: 3 },
        inputImageDataUrls: [],
      },
      byokGemini(),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    )
    for (const b of bodies) {
      expect(b.generationConfig?.candidateCount).toBeUndefined()
      expect(b).toEqual(bodies[0])
    }
    expect(result.images).toEqual([
      'data:image/png;base64,AAA',
      'data:image/png;base64,BBB',
      'data:image/png;base64,CCC',
    ])
  })

  it('throws with API error message on HTTP 400', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT' },
        }),
        { status: 400 },
      ),
    )

    await expect(
      callGeminiImageApi(
        {
          settings: DEFAULT_SETTINGS,
          prompt: 'p',
          params: { ...DEFAULT_PARAMS },
          inputImageDataUrls: [],
        },
        byokGemini(),
      ),
    ).rejects.toThrow(/Invalid argument/)
  })
})
