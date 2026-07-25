interface Entry {
  failures: number
  windowStart: number
  lockedUntil: number
}

export interface RateLimiterOptions {
  maxFailures: number
  windowMs: number
  lockMs: number
  maxEntries?: number
}

export interface RateLimiter {
  recordFailure(key: string): boolean
  recordSuccess(key: string): void
  isLocked(key: string): boolean
}

/**
 * 进程内登录失败限速器。Map 的插入顺序同时充当 LRU，避免伪造 IP 让内存无界增长。
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const entries = new Map<string, Entry>()
  const maxEntries = opts.maxEntries ?? 1024

  function touch(key: string, entry: Entry): void {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined
      if (!oldest) break
      entries.delete(oldest)
    }
  }

  return {
    recordFailure(key) {
      const now = Date.now()
      let entry = entries.get(key)
      if (!entry || now - entry.windowStart > opts.windowMs) {
        entry = { failures: 0, windowStart: now, lockedUntil: 0 }
      }
      entry.failures += 1
      const locked = entry.failures > opts.maxFailures
      if (locked) entry.lockedUntil = now + opts.lockMs
      touch(key, entry)
      return locked
    },
    recordSuccess(key) {
      const entry = entries.get(key)
      if (!entry) return
      entry.failures = 0
      entry.windowStart = Date.now()
      touch(key, entry)
    },
    isLocked(key) {
      return (entries.get(key)?.lockedUntil ?? 0) > Date.now()
    },
  }
}
