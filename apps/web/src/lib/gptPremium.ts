import { isGptDirectModel } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { bffBaseUrl } from './runtimeConfig'

/** 每个账号只问一次；登录换人时按新账号重新问。 */
const premiumByUser = new Map<string, Promise<boolean>>()

function fetchPremium(userId: string): Promise<boolean> {
  let pending = premiumByUser.get(userId)
  if (!pending) {
    pending = fetch(`${bffBaseUrl()}/api/gpt/premium`, { credentials: 'include' })
      .then(async (res) =>
        res.ok ? ((await res.json()) as { premium?: unknown }).premium === true : false,
      )
      .catch(() => false)
    premiumByUser.set(userId, pending)
  }
  return pending
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
    void fetchPremium(userId).then((value) => {
      if (active) setPremium(value)
    })
    return () => {
      active = false
    }
  }, [gpt, directOn, userId])
  // 只有「开通会员就能用」时才提示会员专享；直连没开时会员也用不了，不拿会员说事。
  return { locked: gpt && (!premium || !directOn), memberOnly: gpt && directOn && !premium }
}
