import { useEffect, useState } from 'react'

/**
 * 短于这个时间的读取不画等待层。
 * 盖上来再揭掉，比多等一下更扎眼。
 */
export const LOADING_MARK_HOLD_MS = 1000

/**
 * 条件持续成立 `holdMs` 之后才算数。中途落下就当没发生过。
 */
export function useHeldLoading(active: boolean, holdMs = LOADING_MARK_HOLD_MS): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!active) {
      setHeld(false)
      return
    }
    const timer = window.setTimeout(() => setHeld(true), holdMs)
    return () => window.clearTimeout(timer)
  }, [active, holdMs])
  return active && held
}
