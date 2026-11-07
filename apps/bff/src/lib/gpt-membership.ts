import { log } from './logger'
import { loadPrivateBffOverlay } from './private-overlay'

/**
 * 账号此刻是否会员。私有 overlay 缺席、没实现 isActiveMember 或查询失败都按非会员：
 * 非会员只会被收到 2K、非高画质，不会把 4K 或高画质发出去。
 */
export async function isActiveMember(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  try {
    const { taskHooks } = await loadPrivateBffOverlay()
    if (!taskHooks.isActiveMember) return false
    return await taskHooks.isActiveMember({ userId, now: Date.now() })
  } catch (err) {
    log.warn({ event: 'gpt.membership_lookup_failed', err }, 'membership lookup failed')
    return false
  }
}
