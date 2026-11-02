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

  it('认得 sub2api 的无兼容账号（10-29 flare 事故原文）', () => {
    expect(isModelUnavailableRejection({ message: 'No available compatible accounts' })).toBe(true)
    expect(
      isModelUnavailableRejection({
        message: 'upstream returned 503',
        payload: { error: { type: 'api_error', message: 'No available compatible accounts' } },
      }),
    ).toBe(true)
    expect(
      isModelUnavailableRejection({ payload: '{"error":"No available compatible accounts"}' }),
    ).toBe(true)
    expect(isModelUnavailableRejection({ message: 'No available OpenAI accounts' })).toBe(true)
    expect(isModelUnavailableRejection({ message: '当前分组没有可用账号' })).toBe(true)
  })

  it('普通上游故障不算', () => {
    expect(isModelUnavailableRejection({ message: 'upstream returned 502: Bad Gateway' })).toBe(
      false,
    )
    expect(isModelUnavailableRejection({ message: 'rate limit exceeded' })).toBe(false)
    expect(isModelUnavailableRejection({ message: 'No available capacity, try again later' })).toBe(
      false,
    )
    expect(isModelUnavailableRejection({ message: 'service temporarily unavailable' })).toBe(false)
  })

  it('归入智能体的模型不可用', () => {
    expect(taskFailureCode('model_unavailable')).toBe('model_unavailable')
  })
})
