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

  /**
   * 淘汰时优先挑未锁定的条目。纯按插入顺序淘汰会开一个后门：`isLocked` 是只读的、
   * 不 touch 条目，锁定条目于是停在原插入位置慢慢变成「最老」，攻击者只要灌
   * maxEntries 个伪造 key（不同用户名或轮换 source header）就能把目标已生效的
   * lockedUntil 挤出 Map，锁定在 lockMs 到期前就失效。
   */
  function evict(now: number): void {
    // touch 每次最多让 size 超出 1，所以淘汰一个就够，不需要循环。
    if (entries.size <= maxEntries) return

    let victim: string | undefined
    let earliestLock = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.lockedUntil <= now) {
        victim = key // 插入顺序里最老的未锁定条目
        break
      }
      // 退化路径：全部条目都锁着（需要 maxFailures × maxEntries 次真实失败才能
      // 造出来）。退而淘汰最早解锁的那个，保证 Map 始终有界。
      if (entry.lockedUntil < earliestLock) {
        earliestLock = entry.lockedUntil
        victim = key
      }
    }
    if (victim !== undefined) entries.delete(victim)
  }

  function touch(key: string, entry: Entry, now: number): void {
    entries.delete(key)
    entries.set(key, entry)
    evict(now)
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
      touch(key, entry, now)
      return locked
    },
    recordSuccess(key) {
      const entry = entries.get(key)
      if (!entry) return
      const now = Date.now()
      entry.failures = 0
      entry.windowStart = now
      touch(key, entry, now)
    },
    isLocked(key) {
      return (entries.get(key)?.lockedUntil ?? 0) > Date.now()
    },
  }
}
