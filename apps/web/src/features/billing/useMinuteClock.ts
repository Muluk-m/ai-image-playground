import type { UserAccountSnapshot } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { isBillingExpiryStale } from './billing-display'
import { loadBilling } from './billing-store'

const TICK_MS = 60_000
const MAX_BACKOFF_MS = 5 * 60_000
const RECOVERY_COOLDOWN_MS = 10_000

function staleBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(TICK_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)
}

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
 * 对同一份未变化的到期快照采用有上限指数退避（1 → 2 → 4 → 5 分钟，后台标签页暂停），
 * 并在网络恢复或重新回到前台时按防抖冷却重置重试，既防时钟偏差刷爆接口，也不会因短暂断网永久卡死。
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
    ? `${account?.account?.subscription_expires_at ?? ''}:${account?.account?.subscription_balance ?? ''}:${account?.subscription?.ends_at ?? ''}:${account?.subscription?.next_grant_at ?? ''}`
    : ''

  useEffect(() => {
    if (!stale) {
      stateRef.current = { key: '', attempts: 0, lastAttemptAt: 0 }
      return
    }
    if (document.hidden) return
    if (stateRef.current.key !== staleKey) {
      stateRef.current = { key: staleKey, attempts: 0, lastAttemptAt: 0 }
    }
    const current = stateRef.current
    const waitMs = staleBackoffMs(current.attempts)
    if (current.lastAttemptAt > 0 && now - current.lastAttemptAt < waitMs) return
    current.attempts += 1
    current.lastAttemptAt = now
    void loadBilling()
  }, [stale, staleKey, now])

  useEffect(() => {
    if (!stale) return
    const recover = () => {
      if (document.hidden) return
      const current = stateRef.current
      const triggerAt = Date.now()
      if (current.lastAttemptAt > 0 && triggerAt - current.lastAttemptAt < RECOVERY_COOLDOWN_MS) {
        return
      }
      stateRef.current = { key: staleKey, attempts: 1, lastAttemptAt: triggerAt }
      void loadBilling()
    }
    window.addEventListener('online', recover)
    document.addEventListener('visibilitychange', recover)
    return () => {
      window.removeEventListener('online', recover)
      document.removeEventListener('visibilitychange', recover)
    }
  }, [stale, staleKey])
}
