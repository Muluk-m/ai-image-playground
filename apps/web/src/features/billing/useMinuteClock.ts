import type { UserAccountSnapshot } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { isBillingExpiryStale } from './billing-display'
import { loadBilling } from './billing-store'

const TICK_MS = 60_000
const MAX_STALE_REFRESH_ATTEMPTS = 3

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

/**
 * 跨过积分或套餐到期点时自动重新拉取账户快照，避免界面继续展示未清零的旧余额。
 * 对同一份未变化的到期快照限频且封顶重试次数，防止客户端与服务端时钟轻微偏差时循环请求。
 */
export function useRefreshOnExpiry(
  enabled: boolean,
  account: UserAccountSnapshot | null | undefined,
  now: number,
): void {
  const stateRef = useRef<{ key: string; attempts: number; lastAttemptAt: number }>({
    key: '',
    attempts: 0,
    lastAttemptAt: 0,
  })
  const stale = enabled && isBillingExpiryStale(account, now)
  const staleKey = stale
    ? `${account?.account?.subscription_expires_at ?? ''}:${account?.account?.subscription_balance ?? ''}:${account?.subscription?.ends_at ?? ''}`
    : ''

  useEffect(() => {
    if (!stale) {
      stateRef.current = { key: '', attempts: 0, lastAttemptAt: 0 }
      return
    }
    if (stateRef.current.key !== staleKey) {
      stateRef.current = { key: staleKey, attempts: 0, lastAttemptAt: 0 }
    }
    const current = stateRef.current
    if (current.attempts >= MAX_STALE_REFRESH_ATTEMPTS) return
    if (current.lastAttemptAt > 0 && now - current.lastAttemptAt < TICK_MS) return
    current.attempts += 1
    current.lastAttemptAt = now
    void loadBilling()
  }, [stale, staleKey, now])
}
