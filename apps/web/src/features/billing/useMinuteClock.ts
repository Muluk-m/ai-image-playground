import { useEffect, useState } from 'react'

const TICK_MS = 60_000

/**
 * 供到期倒计时使用的分钟级时钟。仅在存在到期时间时挂定时器，
 * 切回前台时立即对齐，避免长驻标签页的倒计时停在旧天数。
 */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const sync = () => setNow(Date.now())
    sync()
    const timer = window.setInterval(sync, TICK_MS)
    const onVisibility = () => {
      if (!document.hidden) sync()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])

  return now
}
