import { useEffect, useState } from 'react'

/** 已用时长：不足一分钟读秒，超过后读「分:秒」。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
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
