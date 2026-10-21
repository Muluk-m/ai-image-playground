import { describe, expect, it } from 'vitest'
import { toAgentTurnParams } from '../../../../features/agent/lib/turnParams'
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
})
