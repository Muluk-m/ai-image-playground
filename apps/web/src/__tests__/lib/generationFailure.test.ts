import { describe, expect, it } from 'vitest'
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
    expect(text).toBe('生成服务出错了，这次没有出来')
  })

  it('asks for another model when the model is unavailable', () => {
    expect(
      generationFailure(taskFailure('No eligible Grok media accounts', 'model_unavailable')).text,
    ).toBe('该模型暂不可用，请换其他模型')
  })

  it('keeps the error itself for unclassified failures', () => {
    expect(generationFailure(new Error('上游拒绝了这张图')).text).toContain('上游拒绝了这张图')
  })
})
