import { clampGptBasicRequest, isGptBasicRequest, isGptDirectModel } from '@image-playground/shared'
import { log } from './logger'
import { loadPrivateBffOverlay } from './private-overlay'
import { gptDirectConfigured } from './upstream/gpt-routing'

/**
 * 账号此刻是否会员。私有 overlay 缺席、没实现 isActiveMember 或查询失败都按非会员：
 * 非会员只会被收到基础档、走 sub2api，不会多扣钱。
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
 * 2K、4K 与高画质只开给会员（sub2api 兑现不了，直连才有）。非会员提交这些参数时静默收到基础档，
 * 计价与执行都按收后的参数。会员原样放行；直连没开时谁都收到基础档。
 */
export async function alignGptRequestToMembership<T extends { size?: string; quality?: string }>(
  model: string,
  request: T,
  userId: string | null | undefined,
): Promise<T> {
  if (!isGptDirectModel(model) || isGptBasicRequest(request)) return request
  if (gptDirectConfigured(model) && (await isActiveMember(userId))) return request
  return clampGptBasicRequest(model, request)
}
