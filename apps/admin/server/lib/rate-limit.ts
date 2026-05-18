/**
 * 内存 LRU rate limiter。键 = IP 字符串。
 * - maxFailures 次失败 → recordFailure 返 true 表示需要锁定
 * - 锁定期间 isLocked 持续 true
 * - 成功调用 recordSuccess 清空失败计数（保持 unlocked）
 * - maxEntries 满后淘汰最久未访问的 IP（防内存无界增长）
 *
 * 单实例（admin 进程内），进程重启清空 — 自用场景可接受。
 */

interface Entry {
  failures: number
  /** 失败窗口起点（Date.now()）；超过 windowMs 重置 failures */
  windowStart: number
  /** 锁定到此时间戳（Date.now()）；< now 视为未锁 */
  lockedUntil: number
}

export interface RateLimiterOptions {
  maxFailures: number
  windowMs: number
  lockMs: number
  /** 默认 1024 */
  maxEntries?: number
}

export interface RateLimiter {
  /** 记一次失败。返回是否进入锁定（即刚刚到第 maxFailures+1 次）。 */
  recordFailure(key: string): boolean
  /** 记一次成功；清失败计数（不解锁——锁了就锁了，等 lockMs 过） */
  recordSuccess(key: string): void
  isLocked(key: string): boolean
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const maxEntries = opts.maxEntries ?? 1024
  // Map 在 JS 中保留插入顺序，删除再插入 = 移到末尾，天然 LRU
  const entries = new Map<string, Entry>()

  function touch(key: string, entry: Entry) {
    entries.delete(key)
    entries.set(key, entry)
    // 淘汰最老的（Map 第一个）
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined
      if (oldest === undefined) break
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
      const justLocked = entry.failures > opts.maxFailures
      if (justLocked) {
        entry.lockedUntil = now + opts.lockMs
      }
      touch(key, entry)
      return justLocked
    },
    recordSuccess(key) {
      const entry = entries.get(key)
      if (!entry) return
      entry.failures = 0
      entry.windowStart = Date.now()
      touch(key, entry)
    },
    isLocked(key) {
      const entry = entries.get(key)
      if (!entry) return false
      return entry.lockedUntil > Date.now()
    },
  }
}
