import { describe, expect, it } from 'bun:test'
import { createRateLimiter } from '../../lib/rate-limit'

describe('createRateLimiter', () => {
  it('locks the sixth failed login and keeps keys isolated', () => {
    const limiter = createRateLimiter({
      maxFailures: 5,
      windowMs: 60_000,
      lockMs: 600_000,
    })
    for (let i = 0; i < 5; i++) {
      expect(limiter.recordFailure('ip-a')).toBe(false)
    }
    expect(limiter.recordFailure('ip-a')).toBe(true)
    expect(limiter.isLocked('ip-a')).toBe(true)
    expect(limiter.isLocked('ip-b')).toBe(false)
  })

  it('resets failures after a successful login', () => {
    const limiter = createRateLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      lockMs: 600_000,
    })
    limiter.recordFailure('ip-a')
    limiter.recordFailure('ip-a')
    limiter.recordSuccess('ip-a')
    expect(limiter.recordFailure('ip-a')).toBe(false)
    expect(limiter.recordFailure('ip-a')).toBe(false)
    expect(limiter.recordFailure('ip-a')).toBe(true)
  })
})
