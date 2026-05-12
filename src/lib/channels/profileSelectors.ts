import type { ClientProfile, PublicChannel } from './types'

/** 返回该 profile 当前可选模型 id 列表。 */
export function getProfileModels(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): string[] {
  if (profile.source === 'builtin-edge') {
    const channel = publicChannels.find((c) => c.id === profile.channelId)
    return channel ? channel.models.map((m) => m.id) : []
  }
  return profile.models
}

/**
 * 返回该 profile 的模型展示项（id + 人类可读 label）。
 * builtin-edge 从 channel.models 取 label；user-byok 没有 label，用 id 兜底。
 */
export function getProfileModelOptions(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): Array<{ id: string; label: string }> {
  if (profile.source === 'builtin-edge') {
    const channel = publicChannels.find((c) => c.id === profile.channelId)
    return channel ? channel.models.map((m) => ({ id: m.id, label: m.label ?? m.id })) : []
  }
  return profile.models.map((id) => ({ id, label: id }))
}

/** 返回该 profile 当前激活的模型 id；若失效则回退到 models[0]，再失效返回空串。 */
export function getSelectedModel(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): string {
  const models = getProfileModels(profile, publicChannels)
  if (models.includes(profile.selectedModelId)) return profile.selectedModelId
  return models[0] ?? ''
}

/**
 * 替换 BYOK profile 的 models[]，保证 selectedModelId 仍 ∈ models。
 * 仅对 user-byok 生效（builtin-edge 的 models 由 channel 决定，无法在客户端改）。
 */
export function updateProfileModels(
  profile: ClientProfile,
  nextModels: string[],
): ClientProfile {
  if (profile.source === 'builtin-edge') return profile

  const deduped = Array.from(new Set(nextModels.filter((m) => m.trim().length > 0)))
  if (deduped.length === 0) return profile

  const selectedModelId = deduped.includes(profile.selectedModelId)
    ? profile.selectedModelId
    : deduped[0]
  return { ...profile, models: deduped, selectedModelId }
}

/**
 * 切换 selectedModelId；若 modelId 不在当前 models 中，BYOK 自动追加，
 * builtin-edge 则忽略（channel.models 不可在客户端修改）。
 */
export function updateSelectedModel(
  profile: ClientProfile,
  modelId: string,
  publicChannels: PublicChannel[],
): ClientProfile {
  if (!modelId.trim()) return profile

  if (profile.source === 'builtin-edge') {
    const channel = publicChannels.find((c) => c.id === profile.channelId)
    const valid = channel?.models.some((m) => m.id === modelId) ?? false
    return valid ? { ...profile, selectedModelId: modelId } : profile
  }

  const models = profile.models.includes(modelId)
    ? profile.models
    : [...profile.models, modelId]
  return { ...profile, models, selectedModelId: modelId }
}
