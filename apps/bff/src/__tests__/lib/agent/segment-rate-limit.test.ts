import { describe, expect, it } from 'bun:test'
import { createSegmentRateLimiter } from '../../../lib/agent/segment-rate-limit'

describe('segment rate limit', () => {
  it('lets one request per user run at a time', () => {
    const limiter = createSegmentRateLimiter(10)
    const release = limiter.begin('u1')
    expect(release).toBeFunction()
    expect(limiter.begin('u1')).toBeNull()
    // 另一个用户不受影响。
    expect(limiter.begin('u2')).toBeFunction()
    release!()
    release!()
    expect(limiter.begin('u1')).toBeFunction()
  })

  it('caps requests per user per minute and resets with the window', () => {
    let now = 0
    const limiter = createSegmentRateLimiter(3, () => now)
    for (let i = 0; i < 3; i++) limiter.begin('u1')!()
    expect(limiter.begin('u1')).toBeNull()
    expect(limiter.begin('u2')).toBeFunction()
    now = 61_000
    expect(limiter.begin('u1')).toBeFunction()
  })
})
