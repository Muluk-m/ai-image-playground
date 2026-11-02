import { describe, expect, it } from 'vitest'
import { UserFacingError } from '../../i18n'
import { generationFailure } from '../../lib/generationJob'
import { taskFailure } from '../../lib/taskError'

describe('generation failure text', () => {
  it('says the request never left when the browser could not reach the server', () => {
    expect(generationFailure(new TypeError('Failed to fetch')).text).toBe(
      '网络中断，这一张没能完成，请重试。',
    )
  })

  it('shows the localized reason instead of the upstream message for classified failures', () => {
    const text = generationFailure(
      taskFailure('upstream returned 502: <html>Bad Gateway</html>', 'upstream_error'),
    ).text
    expect(text).toBe('生成服务异常，本次未能完成')
  })

  it('asks for another model when the model is unavailable', () => {
    expect(
      generationFailure(taskFailure('No eligible Grok media accounts', 'model_unavailable')).text,
    ).toBe('该模型暂不可用，请换其他模型')
  })

  it('keeps our own user-facing message for unclassified failures', () => {
    expect(generationFailure(new UserFacingError('积分不足，请充值或开通套餐后再生成')).text).toBe(
      '积分不足，请充值或开通套餐后再生成',
    )
  })

  it('hides raw messages of unexpected errors', () => {
    expect(generationFailure(new Error('Cannot read properties of undefined')).text).toBe(
      '操作没有完成，请重试',
    )
  })
})
