import { isGptDirectModel } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { bffBaseUrl } from './runtimeConfig'

/** 会员状态缓存这么久：开通或到期后最多这么久就跟上，不必刷新页面。 */
const PREMIUM_CACHE_MS = 5 * 60 * 1000

/** 按「BFF 地址 + 账号」缓存；查询失败不缓存，下次挂载再问。 */
const premiumCache = new Map<string, { at: number; value: Promise<boolean> }>()

function fetchPremium(userId: string): Promise<boolean> {
  const key = `${bffBaseUrl()}|${userId}`
  const cached = premiumCache.get(key)
  if (cached && Date.now() - cached.at < PREMIUM_CACHE_MS) return cached.value.catch(() => false)
  const value = fetch(`${bffBaseUrl()}/api/gpt/premium`, { credentials: 'include' }).then(
    async (res) => {
      if (!res.ok) throw new Error(`gpt premium ${res.status}`)
      return ((await res.json()) as { premium?: unknown }).premium === true
    },
  )
  premiumCache.set(key, { at: Date.now(), value })
  // 网络中断或 5xx 不能记成「非会员」一直锁着：清掉缓存，这次按锁住处理，下次再问。
  return value.catch(() => {
    if (premiumCache.get(key)?.value === value) premiumCache.delete(key)
    return false
  })
}

/**
 * GPT 直连模型的 2K、4K 与高画质只开给会员（sub2api 兑现不了），由服务端 `/api/gpt/premium` 判定。
 * 非会员时这些选项置灰，服务端也会把越档的提交收回 1K、非高画质。`directOn` 取模型是否声明了 size：
 * 服务端只在 OpenAI 直连开着时声明它，没开时谁都只有基础档。
 */
export function useGptPremiumLocked(
  model: string,
  directOn: boolean,
): { locked: boolean; memberOnly: boolean } {
  const userId = useAuth().user?.id ?? null
  const gpt = isGptDirectModel(model)
  const [premium, setPremium] = useState(false)
  useEffect(() => {
    setPremium(false)
    if (!gpt || !directOn || !userId) return
    let active = true
    let latest = 0
    const refresh = () => {
      // 只认最后一次发出的查询：慢的旧请求晚到时不能把新结果改回去。
      const request = ++latest
      void fetchPremium(userId).then((value) => {
        if (active && request === latest) setPremium(value)
      })
    }
    refresh()
    // 页面一直开着时也要跟上开通或到期：回到页面时、以及每过一个缓存期重问一次（缓存未过期时不发请求）。
    const timer = setInterval(refresh, PREMIUM_CACHE_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [gpt, directOn, userId])
  // 只有「开通会员就能用」时才提示会员专享；直连没开时会员也用不了，不拿会员说事。
  return { locked: gpt && (!premium || !directOn), memberOnly: gpt && directOn && !premium }
}
