import { isGptDirectModel } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { bffBaseUrl } from './runtimeConfig'

/** 会员状态缓存这么久：开通或到期后最多这么久就跟上，不必刷新页面。 */
const PREMIUM_CACHE_MS = 5 * 60 * 1000

export interface GptPremiumAccess {
  /** 旧语义：直连开着且是会员。老前端用它把 2K 以上全部锁住。 */
  premium: boolean
  member: boolean
  /** 这个账号在创作页能选到的最高档。非会员是 2K，会员是 4K。 */
  maxTier: '2K' | '4K'
  highQuality: boolean
  /** 4K 与高画质不可用。 */
  locked: boolean
  /** 直连开着但不是会员：提示最高 2K，高画质仍是会员专享。 */
  memberOnly: boolean
  /** 查询已经有结果。还在飞时不要按这个结果改已存参数，免得把会员的 4K 收掉。 */
  settled: boolean
}

const LOCKED_ACCESS: GptPremiumAccess = {
  premium: false,
  member: false,
  maxTier: '2K',
  highQuality: false,
  locked: true,
  memberOnly: false,
  settled: false,
}

/** 按「BFF 地址 + 账号」缓存；查询失败不缓存，下次挂载再问。 */
const premiumCache = new Map<string, { at: number; value: Promise<GptPremiumAccess | null> }>()

/** `/api/gpt/premium` 的响应。缺了新字段时用旧的 `premium` 推，老服务端仍能把会员放开。 */
export function readGptPremiumBody(body: unknown): GptPremiumAccess {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const premium = record.premium === true
  const member = typeof record.member === 'boolean' ? record.member : premium
  const maxTier: '2K' | '4K' =
    record.maxTier === '4K' || record.maxTier === '2K' ? record.maxTier : premium ? '4K' : '2K'
  const highQuality = typeof record.highQuality === 'boolean' ? record.highQuality : premium
  return {
    premium,
    member,
    maxTier,
    highQuality,
    locked: !highQuality,
    memberOnly: !member,
    settled: true,
  }
}

function fetchPremium(userId: string): Promise<GptPremiumAccess | null> {
  const key = `${bffBaseUrl()}|${userId}`
  const cached = premiumCache.get(key)
  if (cached && Date.now() - cached.at < PREMIUM_CACHE_MS) return cached.value.catch(() => null)
  const value = fetch(`${bffBaseUrl()}/api/gpt/premium`, { credentials: 'include' }).then(
    async (res) => {
      if (!res.ok) throw new Error(`gpt premium ${res.status}`)
      return readGptPremiumBody(await res.json())
    },
  )
  premiumCache.set(key, { at: Date.now(), value })
  // 网络中断或 5xx 不能记成「非会员」一直锁着：清掉缓存，这次不改已存参数，下次再问。
  return value.catch(() => {
    if (premiumCache.get(key)?.value === value) premiumCache.delete(key)
    return null
  })
}

/**
 * GPT 直连模型的 4K 与高画质只开给会员，2K 对非会员开放。由服务端 `/api/gpt/premium` 判定。
 * 非会员选不了 4K 和高画质，服务端也会把越档的提交收到 2K、非高画质。`directOn` 取模型是否声明了 size：
 * 服务端只在 OpenAI 直连开着时声明它，没开时分辨率行不给出档位。
 */
export function useGptPremiumLocked(model: string, directOn: boolean): GptPremiumAccess {
  const userId = useAuth().user?.id ?? null
  const gpt = isGptDirectModel(model)
  const [access, setAccess] = useState<GptPremiumAccess | null | undefined>(undefined)
  useEffect(() => {
    setAccess(undefined)
    if (!gpt || !directOn || !userId) return
    let active = true
    let latest = 0
    const refresh = () => {
      // 只认最后一次发出的查询：慢的旧请求晚到时不能把新结果改回去。
      const request = ++latest
      void fetchPremium(userId).then((value) => {
        if (active && request === latest) setAccess(value)
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
  if (!gpt) {
    return {
      premium: false,
      member: false,
      maxTier: '4K',
      highQuality: true,
      locked: false,
      memberOnly: false,
      settled: true,
    }
  }
  if (!directOn) return { ...LOCKED_ACCESS, memberOnly: false, settled: true }
  if (!userId) return { ...LOCKED_ACCESS, memberOnly: true, settled: true }
  // 查询失败或还在飞：界面先按非会员锁住，但不改已存参数。
  if (!access) return { ...LOCKED_ACCESS, memberOnly: true, settled: false }
  // 只有「开通会员就能用」时才提示会员专享；直连没开时会员也用不了，不拿会员说事。
  return { ...access, memberOnly: !access.member, settled: true }
}
