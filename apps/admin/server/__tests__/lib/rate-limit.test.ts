import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const { createRateLimiter } = await import('../../lib/rate-limit')

describe('createRateLimiter', () => {
  it('前 5 次失败不锁；第 6 次 returnLocked', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('1.1.1.1')).toBe(false)
    }
    expect(rl.recordFailure('1.1.1.1')).toBe(true) // 第 6 次锁
    expect(rl.isLocked('1.1.1.1')).toBe(true)
  })

  it('成功时 reset 失败计数', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 4; i++) rl.recordFailure('2.2.2.2')
    rl.recordSuccess('2.2.2.2')
    // 重新累计也要 5 次才锁
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('2.2.2.2')).toBe(false)
    }
    expect(rl.recordFailure('2.2.2.2')).toBe(true)
  })

  it('不同 IP 各自独立', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 5; i++) rl.recordFailure('3.3.3.3')
    rl.recordFailure('3.3.3.3') // 锁 3.3.3.3
    expect(rl.isLocked('4.4.4.4')).toBe(false)
  })

  it('LRU 容量上限：超出时淘汰最老', () => {
    const rl = createRateLimiter({
      maxFailures: 5,
      windowMs: 60_000,
      lockMs: 600_000,
      maxEntries: 3,
    })
    rl.recordFailure('ip-a')
    rl.recordFailure('ip-b')
    rl.recordFailure('ip-c')
    rl.recordFailure('ip-d') // 应淘汰 ip-a
    // ip-a 重新出现：失败计数应该重置（之前的状态被淘汰了）
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('ip-a')).toBe(false)
    }
  })
})
