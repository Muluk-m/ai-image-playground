import { describe, expect, it } from 'bun:test'
import { taskFailureCode } from '../agent'
import { isModelUnavailableRejection } from '../model-availability'

describe('isModelUnavailableRejection', () => {
  it('认得 Grok 账号池耗尽', () => {
    expect(isModelUnavailableRejection({ message: 'No eligible Grok media accounts' })).toBe(true)
  })

  it('认得响应体里的模型不存在码', () => {
    expect(
      isModelUnavailableRejection({
        message: 'request failed',
        payload: { error: { code: 'model_not_found', message: 'not found' } },
      }),
    ).toBe(true)
  })

  it('认得网关的无可用渠道', () => {
    expect(
      isModelUnavailableRejection({
        payload: { error: { message: '当前分组 default 下对于模型 grok-video 无可用渠道' } },
      }),
    ).toBe(true)
  })

  it('普通上游故障不算', () => {
    expect(isModelUnavailableRejection({ message: 'upstream returned 502: Bad Gateway' })).toBe(
      false,
    )
    expect(isModelUnavailableRejection({ message: 'rate limit exceeded' })).toBe(false)
  })

  it('归入智能体的模型不可用', () => {
    expect(taskFailureCode('model_unavailable')).toBe('model_unavailable')
  })
})
