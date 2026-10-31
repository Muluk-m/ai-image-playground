import { Elysia } from 'elysia'
import { isActiveMember } from '../lib/gpt-membership'
import { gptDirectConfigured } from '../lib/upstream/gpt-routing'
import { requireUser } from '../lib/user-auth'

/**
 * 当前账号能不能用 GPT 直连模型的 2K、4K 与高画质：OpenAI 直连开着且是会员。前端据此解锁档位；
 * 服务端提交时照样按同一口径把越档请求收回基础档（gpt-membership.ts），这里只供展示。
 */
export const gptPremiumRoutes = new Elysia()
  .use(requireUser)
  .get('/api/gpt/premium', async ({ authUser }) => ({
    premium: gptDirectConfigured('gpt-image-2.5-flare') && (await isActiveMember(authUser?.id)),
  }))
