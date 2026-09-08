import type { StoryboardPlanRequest } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { planStoryboard } from '../../lib/storyboardClient'

const REQUEST: StoryboardPlanRequest = {
  idea: '一支讲通勤咖啡的短片',
  shots: 2,
  totalSeconds: 15,
  aspectRatio: '9:16',
}

function shot(no: number) {
  return {
    no,
    title: `第 ${no} 镜`,
    description: '主角在清晨的地铁口捧着纸杯',
    camera: '缓慢推进',
    line: '',
    imagePrompt: 'commuter holding a paper cup at a subway entrance, 9:16',
    videoPrompt: 'slow push in, steam rises',
  }
}

const PLAN = {
  title: '通勤第一口',
  summary: '两镜讲清一杯咖啡的早晨',
  videoPrompt: '通勤者捧着纸杯，清晨地铁口，暖调胶片\n镜头1（0-7.5秒）：推门而出，缓慢推进',
  shots: [shot(1), shot(2)],
}

const TIMED = {
  ...PLAN,
  shots: [
    { ...shot(1), startSeconds: 0, seconds: 7.5 },
    { ...shot(2), startSeconds: 7.5, seconds: 7.5 },
  ],
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

describe('asking the BFF for a storyboard', () => {
  it('posts the request and returns the plan', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ plan: PLAN }))

    const plan = await planStoryboard(REQUEST, fetcher)

    expect(plan).toEqual(TIMED)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://bff.example.com/api/storyboard/plan')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(REQUEST)
  })

  it('rejects a plan whose shots do not match what was asked for', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ plan: { ...PLAN, shots: [shot(1)] } }))

    await expect(planStoryboard(REQUEST, fetcher)).rejects.toThrow('分镜脚本没有生成成功')
  })

  it('rejects an error answer and a body without a plan', async () => {
    const failed = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'storyboard_upstream_error' }, 502))
    await expect(planStoryboard(REQUEST, failed)).rejects.toThrow('分镜脚本没有生成成功')

    const empty = vi.fn().mockResolvedValue(jsonResponse({}))
    await expect(planStoryboard(REQUEST, empty)).rejects.toThrow('分镜脚本没有生成成功')
  })
})
