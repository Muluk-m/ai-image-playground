import { describe, expect, it } from 'vitest'
import { toAgentTurnParams } from '../../../../features/agent/lib/turnParams'
import { DEFAULT_PARAMS } from '../../../../types'

describe('toAgentTurnParams', () => {
  it('默认一张不带上，改过的张数随这一轮送出', () => {
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 1 }, undefined, false)).toBeUndefined()
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 4 }, 'model-a', false)).toMatchObject({
      model: 'model-a',
      n: 4,
    })
  })

  it('超出 1 到 10 的张数不送', () => {
    expect(toAgentTurnParams({ ...DEFAULT_PARAMS, n: 11 }, undefined, false)).toBeUndefined()
  })
})
