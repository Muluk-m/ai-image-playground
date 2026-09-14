import { useEffect, useState } from 'react'

/**
 * 全站唯一的耗时写法：`12s` / `1m 10s` / `2h 5m 30s`。
 *
 * 不用 `1:10` 这种冒号形式：冒号默认读者已经知道量级（播放器进度条旁边有时间轴才成立），
 * 而这里的任务能跑到几分钟甚至更久，`2:05:30` 要先判断是时分秒还是分秒。带单位就不用判断。
 * 代价是稍宽，但耗时从来不排成列。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** 从 `startedAt` 起每秒走一格的已用毫秒数；`startedAt` 为 null 时不计时。 */
export function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  return startedAt === null ? null : Math.max(0, now - startedAt)
}
