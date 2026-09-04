import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeCompetitorImages } from '../../../../features/remix/lib/analyzeClient'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const BRIEF = {
  shotType: 'scene',
  composition: '浴缸居中',
  camera: 'eye level',
  lighting: '侧逆光',
  background: '微水泥浴室',
  props: ['地毯'],
  textZones: [],
  palette: ['#e8e0d4'],
  productBox: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
}

const PRODUCT = { name: 'W2753 浴缸', description: '蛋形单边斜背' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com/' } })
})

afterEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  vi.restoreAllMocks()
})

describe('asking the BFF to analyse competitor images', () => {
  it('posts the images with the product context and returns the briefs', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ briefs: [BRIEF] }))

    const briefs = await analyzeCompetitorImages(['data:image/png;base64,AAA'], PRODUCT, fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/remix/analyze',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      images: ['data:image/png;base64,AAA'],
      product: { name: 'W2753 浴缸', description: '蛋形单边斜背' },
    })
    expect(briefs).toEqual([BRIEF])
  })

  it('keeps a brief without a product box', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ briefs: [{ ...BRIEF, productBox: null }] }))

    const [brief] = await analyzeCompetitorImages(['data:image/png;base64,AAA'], PRODUCT, fetcher)

    expect(brief?.productBox).toBeNull()
  })

  it('fails when the BFF refuses the request', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: 'capability_disabled' }, 404))

    await expect(
      analyzeCompetitorImages(['data:image/png;base64,AAA'], PRODUCT, fetcher),
    ).rejects.toThrow('分析')
  })

  it('fails when the answer is not a list of briefs', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ briefs: [{ shotType: 'scene' }] }))

    await expect(
      analyzeCompetitorImages(['data:image/png;base64,AAA'], PRODUCT, fetcher),
    ).rejects.toThrow('分析')
  })
})
