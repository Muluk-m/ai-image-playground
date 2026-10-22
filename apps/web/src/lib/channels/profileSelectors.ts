import { isModelEtaSeconds, type ModelBadge } from '@image-playground/shared'
import { i18next } from '../../i18n'
import type { ChannelCapability, ClientProfile, PublicChannel } from './types'

/**
 * 当前选中模型支持的能力集合（控制 UI 显隐参考图/遮罩/质量等控件）。
 * 清单来自平台渠道；渠道或模型还没对上时返回 null，调用方按「未知」处理，不猜。
 */
export function getModelCapabilities(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): ReadonlySet<ChannelCapability> | null {
  const channel = publicChannels.find((item) => item.id === profile.channelId)
  const model =
    channel?.models.find((item) => item.id === profile.selectedModelId) ?? channel?.models[0]
  return model ? new Set(model.capabilities) : null
}

/**
 * 模型是否「原生」支持遮罩（走 OpenAI images/edits 的真·inpainting）。
 * 不支持的模型在分发层走软遮罩降级（见 api.ts 的 applySoftMaskFallback）。
 */
export function modelSupportsNativeMask(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): boolean {
  return getModelCapabilities(profile, publicChannels)?.has('mask') ?? false
}

/**
 * 平台渠道的模型清单由 BFF 下发，长开的标签页会停在改名前的旧清单上。
 * 认不出来不等于不支持，不能让它悄悄降级成「无此能力」。
 */
export function isModelKnown(profile: ClientProfile, publicChannels: PublicChannel[]): boolean {
  return getProfileModels(profile, publicChannels).includes(profile.selectedModelId)
}

/** 模型不支持参考图（图生图）时的统一提示文案，多处编辑入口复用。 */
export let NO_EDIT_SUPPORT_MESSAGE = i18next.t('model.noEditSupport', { ns: 'lib' })
i18next.on('languageChanged', () => {
  NO_EDIT_SUPPORT_MESSAGE = i18next.t('model.noEditSupport', { ns: 'lib' })
})

/**
 * 当前模型是否支持 edit（参考图/图生图）。
 * 渠道清单还没到、能力未知时不拦：拦了会在启动窗口里把参考图整条关掉。
 * 清单明确没有 `edit` 时才拒绝。
 */
export function modelSupportsEdit(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): boolean {
  const caps = getModelCapabilities(profile, publicChannels)
  return !caps || caps.has('edit')
}

/** 返回该 profile 当前可选模型 id 列表。 */
export function getProfileModels(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): string[] {
  const channel = publicChannels.find((item) => item.id === profile.channelId)
  return channel ? channel.models.map((model) => model.id) : []
}

/**
 * 选择器提示用的典型耗时。BFF 加载时已限定为 1–3600 的整数；这里按同一条（shared 的
 * `isModelEtaSeconds`）再挡一次，长开的标签页或别的部署发来的清单里有不合法的值时当作没有，
 * 不显示「约 0 秒」「约 -1 秒」这类文案。
 */
export function usableEtaSeconds(value: unknown): number | undefined {
  return isModelEtaSeconds(value) ? value : undefined
}

/** 返回该 profile 的模型展示项（id + 人类可读 label）。 */
export function getProfileModelOptions(
  profile: ClientProfile,
  publicChannels: PublicChannel[],
): Array<{ id: string; label: string; badges?: ModelBadge[]; etaSeconds?: number }> {
  const channel = publicChannels.find((item) => item.id === profile.channelId)
  return channel
    ? channel.models.map((model) => {
        const etaSeconds = usableEtaSeconds(model.etaSeconds)
        return {
          id: model.id,
          label: model.label ?? model.id,
          ...(model.badges?.length ? { badges: model.badges } : {}),
          ...(etaSeconds !== undefined ? { etaSeconds } : {}),
        }
      })
    : []
}

/** 返回该 profile 当前激活的模型 id；若失效则回退到 models[0]，再失效返回空串。 */
export function getSelectedModel(profile: ClientProfile, publicChannels: PublicChannel[]): string {
  const models = getProfileModels(profile, publicChannels)
  if (models.includes(profile.selectedModelId)) return profile.selectedModelId
  return models[0] ?? ''
}

/**
 * 切换 selectedModelId。modelId 不在该渠道的模型清单里则忽略。
 */
export function updateSelectedModel(
  profile: ClientProfile,
  modelId: string,
  publicChannels: PublicChannel[],
): ClientProfile {
  if (!modelId.trim()) return profile
  const channel = publicChannels.find((item) => item.id === profile.channelId)
  const valid = channel?.models.some((model) => model.id === modelId) ?? false
  return valid ? { ...profile, selectedModelId: modelId } : profile
}
