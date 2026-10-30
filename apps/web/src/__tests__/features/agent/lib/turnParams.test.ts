import { describe, expect, it } from 'vitest'
import {
  imageCountChoices,
  snapImageCount,
  toAgentTurnParams,
} from '../../../../features/agent/lib/turnParams'
import { DEFAULT_PARAMS } from '../../../../types'

describe('toAgentTurnParams', () => {
  it('智能体模式不送张数；图片生成模式才带上用户选的档', () => {
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 4 }, 'model-a', false)).toMatchObject({
      model: 'model-a',
    })
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 4 }, 'model-a', false)).not.toHaveProperty('n')
    expect(
      toAgentTurnParams({ ...DEFAULT_PARAMS, n: 4 }, 'model-a', true, { includeCount: true }),
    ).toMatchObject({ model: 'model-a', n: 4, autoSubmit: true })
    expect(
      toAgentTurnParams({ ...DEFAULT_PARAMS, n: 1 }, undefined, false, { includeCount: true }),
    ).toEqual({ autoSubmit: false })
  })

  it('不在 1/2/3/4/6/8 里的张数收到最近的一档，超出范围的不送', () => {
    expect(
      toAgentTurnParams({ ...DEFAULT_PARAMS, n: 5 }, undefined, false, { includeCount: true }),
    ).toMatchObject({ n: 4 })
    expect(
      toAgentTurnParams({ ...DEFAULT_PARAMS, n: 11 }, undefined, false, { includeCount: true }),
    ).toMatchObject({ n: 8 })
  })

  it('Lite 一单最多 4 张：已选 6、8 张送出去的是 4，和服务端收口一致（BUG-91）', () => {
    const lite = 'gemini-3.1-flash-lite-image'
    for (const n of [6, 8, 10]) {
      expect(
        toAgentTurnParams({ ...DEFAULT_PARAMS, n }, lite, true, { includeCount: true }),
      ).toMatchObject({ model: lite, n: 4 })
    }
    expect(
      toAgentTurnParams({ ...DEFAULT_PARAMS, n: 8 }, 'gemini-nano-banana-2.1', true, {
        includeCount: true,
      }),
    ).toMatchObject({ n: 8 })
  })
})

describe('imageCountChoices', () => {
  it('超过模型单笔上限的档不出现，没有上限的模型给全部六档', () => {
    expect(imageCountChoices('gemini-3.1-flash-lite-image')).toEqual([1, 2, 3, 4])
    expect(imageCountChoices('gpt-image-2.5-flare')).toEqual([1, 2, 3, 4, 6, 8])
    expect(imageCountChoices(undefined)).toEqual([1, 2, 3, 4, 6, 8])
  })

  it('张数收到这个模型能选的最近一档', () => {
    expect(snapImageCount(8, 'gemini-3.1-flash-lite-image')).toBe(4)
    expect(snapImageCount(3, 'gemini-3.1-flash-lite-image')).toBe(3)
    expect(snapImageCount(7)).toBe(6)
  })
})
