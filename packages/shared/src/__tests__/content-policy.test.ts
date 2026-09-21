import { describe, expect, it } from 'bun:test'
import { taskFailureCode } from '../agent'
import { isContentPolicyEmptyResult, isContentPolicyRejection } from '../content-policy'

describe('isContentPolicyRejection', () => {
  it('认得 OpenAI 安全系统那句拒绝', () => {
    expect(
      isContentPolicyRejection({
        status: 400,
        message:
          'Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID 2b502fc3.',
      }),
    ).toBe(true)
  })

  it('认得响应体里的内容策略码', () => {
    expect(
      isContentPolicyRejection({
        status: 400,
        message: '生成失败',
        payload: { error: { code: 'content_policy_violation', message: '内容审核拒绝' } },
      }),
    ).toBe(true)
  })

  it('认得 Grok 网关只在人话里说的那一句', () => {
    expect(
      isContentPolicyRejection({
        status: 403,
        message: 'Request blocked by upstream content policy',
      }),
    ).toBe(true)
  })

  it('上游 5xx 一律不算违规，哪怕文案里带了安全字样', () => {
    expect(
      isContentPolicyRejection({ status: 503, message: 'safety system temporarily unavailable' }),
    ).toBe(false)
  })

  it('普通故障不误判', () => {
    expect(isContentPolicyRejection({ status: 429, message: 'Rate limit reached' })).toBe(false)
    expect(isContentPolicyRejection({ status: 401, message: 'Invalid API key' })).toBe(false)
    expect(isContentPolicyRejection({})).toBe(false)
  })
})

describe('isContentPolicyEmptyResult', () => {
  it('Gemini 整段提示词被拦', () => {
    expect(
      isContentPolicyEmptyResult('gemini', { promptFeedback: { blockReason: 'SAFETY' } }),
    ).toBe(true)
  })

  it('Gemini 候选项以审核类 finishReason 收场', () => {
    expect(
      isContentPolicyEmptyResult('gemini', { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }),
    ).toBe(true)
  })

  it('Gemini 抽风（STOP、空响应）不算违规，这类重试能出图', () => {
    expect(isContentPolicyEmptyResult('gemini', { candidates: [{ finishReason: 'STOP' }] })).toBe(
      false,
    )
    expect(isContentPolicyEmptyResult('gemini', {})).toBe(false)
    expect(isContentPolicyEmptyResult('gemini', null)).toBe(false)
  })
})

describe('taskFailureCode', () => {
  it('内容安全拒绝单独成一类，不混进上游故障', () => {
    expect(taskFailureCode('content_policy')).toBe('content_policy')
    expect(taskFailureCode('upstream_error')).toBe('upstream_error')
  })

  it('其余分类照旧', () => {
    expect(taskFailureCode('upstream_timeout')).toBe('timeout')
    expect(taskFailureCode('upstream_no_image')).toBe('no_output')
    // 执行者丢了或上游结局查不到：可能已经出图计费，不能归进可重试的类。
    expect(taskFailureCode('interrupted')).toBe('result_unknown')
    expect(taskFailureCode('upstream_result_unknown')).toBe('result_unknown')
    expect(taskFailureCode('object_storage_error')).toBe('upstream_error')
    expect(taskFailureCode(null)).toBe('upstream_error')
  })
})
