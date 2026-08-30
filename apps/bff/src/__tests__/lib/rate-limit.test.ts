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

  it('keeps a locked key locked when the entry map overflows', () => {
    const maxEntries = 8
    const limiter = createRateLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      lockMs: 600_000,
      maxEntries,
    })
    limiter.recordFailure('victim')
    expect(limiter.recordFailure('victim')).toBe(true)
    expect(limiter.isLocked('victim')).toBe(true)

    // 攻击者用远超容量的伪造 key 灌爆 Map，试图把 victim 的锁定挤出去。
    for (let i = 0; i < maxEntries * 4; i++) {
      limiter.recordFailure(`filler-${i}`)
    }

    expect(limiter.isLocked('victim')).toBe(true)
  })

  it('evicts the soonest-to-expire lock when every entry is locked', () => {
    const maxEntries = 4
    const limiter = createRateLimiter({
      maxFailures: 0,
      windowMs: 60_000,
      lockMs: 600_000,
      maxEntries,
    })
    // maxFailures=0 让每个 key 第一次失败就锁定，制造「全员锁定」的退化场景。
    for (let i = 0; i < maxEntries * 2; i++) {
      expect(limiter.recordFailure(`locked-${i}`)).toBe(true)
    }
    // 最后写入的 key 一定还在（Map 有界，且淘汰挑的是最早解锁的那批）。
    expect(limiter.isLocked(`locked-${maxEntries * 2 - 1}`)).toBe(true)
  })
})
