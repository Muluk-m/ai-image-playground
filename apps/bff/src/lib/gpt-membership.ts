import {
  clampGptNonMemberRequest,
  isGptDirectModel,
  isGptNonMemberRequest,
} from '@image-playground/shared'
import { log } from './logger'
import { loadPrivateBffOverlay } from './private-overlay'
import { gptDirectConfigured } from './upstream/gpt-routing'

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

/**
 * 4K 与高画质只开给会员。非会员提交这些参数时静默收到 2K、非高画质，计价与执行都按收后的参数。
 * 会员原样放行；直连没开时谁都收到非会员上限（2K 仍可能回落到 sub2api，结算再按兑现得了的档退差价）。
 */
export async function alignGptRequestToMembership<T extends { size?: string; quality?: string }>(
  model: string,
  request: T,
  userId: string | null | undefined,
): Promise<T> {
  if (!isGptDirectModel(model) || isGptNonMemberRequest(request)) return request
  if (gptDirectConfigured(model) && (await isActiveMember(userId))) return request
  return clampGptNonMemberRequest(model, request)
}
