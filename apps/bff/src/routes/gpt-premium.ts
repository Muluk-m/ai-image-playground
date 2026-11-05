import { Elysia } from 'elysia'
import { isActiveMember } from '../lib/gpt-membership'
import { gptDirectConfigured } from '../lib/upstream/gpt-routing'
import { requireUser } from '../lib/user-auth'

/**
 * 当前账号的 GPT 直连档位。非会员最高 2K、不能选高画质；会员在直连开着时到 4K、可以选高画质。
 * `premium` 是旧字段（直连开着且是会员），老前端仍用它把 2K 以上全部锁住。
 * 服务端提交时照样按同一口径收档（gpt-membership.ts），这里只供展示。
 */
export const gptPremiumRoutes = new Elysia()
  .use(requireUser)
  .get('/api/gpt/premium', async ({ authUser }) => {
    const member = await isActiveMember(authUser?.id)
    const allowed = gptDirectConfigured('gpt-image-2.5-flare') && member
    return {
      premium: allowed,
      member,
      maxTier: allowed ? ('4K' as const) : ('2K' as const),
      highQuality: allowed,
    }
  })
