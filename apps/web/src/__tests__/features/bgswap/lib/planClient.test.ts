import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestBackgroundPlan, requestSceneScan } from '../../../../features/bgswap/lib/planClient'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const PLAN = {
  category: '折叠浴缸',
  sceneType: 'photo',
  productBox: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
  plan: '放进有窗光的日式木质浴室',
  prompt: '锁住产品……只换背景',
}

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

describe('asking the BFF for a background plan', () => {
  it('posts the image with the preference and returns the plan with its prompt', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(PLAN))

    const result = await requestBackgroundPlan(
      { image: 'data:image/png;base64,AAA', preference: '北欧风' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/bgswap/plan',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      image: 'data:image/png;base64,AAA',
      preference: '北欧风',
    })
    expect(result).toEqual(PLAN)
  })

  it('leaves out an empty preference', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(PLAN))

    await requestBackgroundPlan({ image: 'data:image/png;base64,AAA', preference: '  ' }, fetcher)

    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      image: 'data:image/png;base64,AAA',
    })
  })

  it('sends the language when one is asked for', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(PLAN))

    await requestBackgroundPlan({ image: 'data:image/png;base64,AAA', language: 'en' }, fetcher)

    expect(JSON.parse(fetcher.mock.calls[0][1].body).language).toBe('en')
  })

  it('fails when the BFF refuses the request', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: 'capability_disabled' }, 404))

    await expect(
      requestBackgroundPlan({ image: 'data:image/png;base64,AAA' }, fetcher),
    ).rejects.toThrow('背景方案')
  })

  it('fails when the answer carries no usable plan', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...PLAN, plan: '   ' }))

    await expect(
      requestBackgroundPlan({ image: 'data:image/png;base64,AAA' }, fetcher),
    ).rejects.toThrow('背景方案')
  })

  it('fails when the answer carries no prompt', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...PLAN, prompt: '' }))

    await expect(
      requestBackgroundPlan({ image: 'data:image/png;base64,AAA' }, fetcher),
    ).rejects.toThrow('背景方案')
  })

  it('rejects a plan whose scene kind is none of the four', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...PLAN, sceneType: '纯白背景' }))

    await expect(
      requestBackgroundPlan({ image: 'data:image/png;base64,AAA' }, fetcher),
    ).rejects.toThrow('背景方案')
  })
})

describe('asking the BFF what kind of image this is', () => {
  it('posts the image and returns the scene kind', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ sceneType: 'collage' }))

    const sceneType = await requestSceneScan('data:image/png;base64,AAA', fetcher)

    expect(sceneType).toBe('collage')
    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/bgswap/scan',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      image: 'data:image/png;base64,AAA',
    })
  })

  it('fails when the scan is unavailable or unusable', async () => {
    await expect(
      requestSceneScan(
        'data:image/png;base64,AAA',
        vi.fn().mockResolvedValue(jsonResponse({}, 404)),
      ),
    ).rejects.toThrow('画面类型')
    await expect(
      requestSceneScan(
        'data:image/png;base64,AAA',
        vi.fn().mockResolvedValue(jsonResponse({ sceneType: '说明图' })),
      ),
    ).rejects.toThrow('画面类型')
  })
})
