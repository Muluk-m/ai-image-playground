import { toQueueProvider } from '../../../lib/channels/queueClient'
import type { ClientProfile, ProviderKind, PublicChannel } from '../../../lib/channels/types'

export interface MatchProfileInput {
  profiles: ClientProfile[]
  publicChannels: PublicChannel[]
  activeProfileId: string
  provider: ProviderKind
  model: string
}

/**
 * 按 (provider, model) 在 profiles 中找最佳匹配。
 *
 * 优先级：
 * 1. 当前 active profile（如果它符合 provider+model）
 * 2. builtin-edge（密钥不暴露，更安全）
 * 3. user-byok
 *
 * 返回 null 表示没有任何 profile 同时满足 provider 与 model 约束。
 */
export function matchProfile(input: MatchProfileInput): ClientProfile | null {
  const { profiles, publicChannels, activeProfileId, provider, model } = input

  const candidates = profiles.filter((p) => profileSatisfies(p, publicChannels, provider, model))
  if (candidates.length === 0) return null

  const active = candidates.find((p) => p.id === activeProfileId)
  if (active) return active

  const builtin = candidates.find((p) => p.source === 'builtin-edge')
  if (builtin) return builtin

  return candidates[0]
}

function profileSatisfies(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
  provider: ProviderKind,
  model: string,
): boolean {
  if (profile.source === 'user-byok') {
    return profile.kind === provider && profile.models.includes(model)
  }
  const channel = publicChannels.find((c) => c.id === profile.channelId)
  if (!channel) return false
  // Inspiration manifest 用「请求风格」描述 provider（'openai-compat' / 'gemini'），
  // 内置 channel 用 BFF 队列 kind（'openai-queue' / 'gemini-queue'）。
  // toQueueProvider 把两边都规约到同一个 QueueProvider 轴，做兼容匹配。
  const channelFamily = toQueueProvider(channel.kind)
  if (!channelFamily || channelFamily !== toQueueProvider(provider)) return false
  return channel.models.some((m) => m.id === model)
}
