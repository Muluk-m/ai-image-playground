import { getProfileModels } from '../../../lib/channels/profileSelectors'
import { toQueueProvider } from '../../../lib/channels/queueClient'
import type { ClientProfile, ProviderKind, PublicChannel } from '../../../lib/channels/types'

export interface MatchProfileInput {
  profiles: ClientProfile[]
  publicChannels: PublicChannel[]
  activeProfileId: string
  provider: ProviderKind
  model: string
}

export interface MatchProfileResult {
  profile: ClientProfile
  /** 实际要选中的模型 id：精确命中时即请求的 model，同族回退时是替代 id。 */
  model: string
}

// 上游改名（gpt-image-2 → gpt-image-2.5-flare）会让灵感库钉死的 model id 整片失配，
// 同族前缀是兜底。放宽匹配的口子只此一个，要再开先想清楚。
const GPT_IMAGE_PREFIX = 'gpt-image-'

/**
 * 按 (provider, model) 在 profiles 中找最佳匹配，并给出实际要选中的模型。
 *
 * 精确命中 model 的 profile 整体优先于同族回退；两档内部都按
 * active profile > builtin-edge（密钥不暴露）> 其余 的顺序取第一个。
 *
 * 返回 null 表示没有任何 profile 能在该 provider 下服务这个模型或其同族模型。
 */
export function matchProfile(input: MatchProfileInput): MatchProfileResult | null {
  const { profiles, publicChannels, activeProfileId, provider, model } = input
  const familyPrefix = model.startsWith(GPT_IMAGE_PREFIX) ? GPT_IMAGE_PREFIX : null

  const candidates = profiles.flatMap((profile) => {
    const models = servableModelIds(profile, publicChannels, provider)
    const picked = models.includes(model)
      ? model
      : familyPrefix && models.find((m) => m.startsWith(familyPrefix))
    return picked ? [{ profile, model: picked }] : []
  })

  const exact = candidates.filter((c) => c.model === model)
  const pool = exact.length > 0 ? exact : candidates

  return (
    pool.find((c) => c.profile.id === activeProfileId) ??
    pool.find((c) => c.profile.source === 'builtin-edge') ??
    pool[0] ??
    null
  )
}

/** 该 profile 在给定 provider 下能服务的模型 id；provider 不匹配返回空数组。 */
function servableModelIds(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
  provider: ProviderKind,
): string[] {
  if (profile.source === 'user-byok') {
    return profile.kind === provider ? getProfileModels(profile, publicChannels) : []
  }
  // Inspiration manifest 用「请求风格」描述 provider（'openai-compat' / 'gemini'），
  // 内置 channel 用 BFF 队列 kind（'openai-queue' / 'gemini-queue'）。
  // toQueueProvider 把两边都规约到同一个 QueueProvider 轴，做兼容匹配。
  const channel = publicChannels.find((c) => c.id === profile.channelId)
  const channelFamily = channel && toQueueProvider(channel.kind)
  if (!channelFamily || channelFamily !== toQueueProvider(provider)) return []
  return getProfileModels(profile, publicChannels)
}
