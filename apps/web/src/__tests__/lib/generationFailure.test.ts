import { describe, expect, it } from 'vitest'
import { generationFailure } from '../../lib/generationJob'

describe('generation failure text', () => {
  it('says the request never left when the browser could not reach the server', () => {
    expect(generationFailure(new TypeError('Failed to fetch')).text).toBe(
      '网络中断，这一张没有发出去，请重试。',
    )
  })

  it('keeps the error itself for other failures', () => {
    expect(generationFailure(new Error('上游拒绝了这张图')).text).toContain('上游拒绝了这张图')
  })
})
