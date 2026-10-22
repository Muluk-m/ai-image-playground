import { createWindowLimiter } from '../rate-limit'

/** 每个用户每分钟最多点这么多下；正常调整一张卡片远用不到。 */
const SEGMENT_REQUESTS_PER_USER_MINUTE = 30

/**
 * 卡片点选细化的每用户限额。分割服务单并发、队列很短，并由多个部署共用：一个用户连点或脚本刷
 * 不能把它占满。两条都要：每分钟次数上限，加同一用户同时只跑一个请求（新点的等上一个回来）。
 * 进程内计数，与对话轮次的限速一样；被拒的请求回 429，卡片保留当前范围。
 */
export function createSegmentRateLimiter(
  perMinute = SEGMENT_REQUESTS_PER_USER_MINUTE,
  now?: () => number,
) {
  const window = createWindowLimiter(60_000, 4096, now)
  const running = new Set<string>()
  return {
    /** 放行时返回收尾函数（请求结束时调用一次），超限时返回 null。 */
    begin(userId: string): (() => void) | null {
      if (running.has(userId)) return null
      if (window.over(userId, perMinute)) return null
      running.add(userId)
      let done = false
      return () => {
        if (done) return
        done = true
        running.delete(userId)
      }
    },
  }
}

export const segmentRateLimiter = createSegmentRateLimiter()
