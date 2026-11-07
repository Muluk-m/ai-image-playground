import {
  type ImageRateRequest,
  type ImageTierEntry,
  isGptDirectModel,
  isGptImage26Model,
  resolveImageTier,
} from '@image-playground/shared'
import { getPublicChannels } from './channels/publicChannels'

/** 渠道明确声明的可出档。没声明就不收档，和 BFF `declaredImageSizes` 同一口径。 */
export function declaredImageSizesForModel(model: string): readonly string[] | undefined {
  for (const channel of getPublicChannels()) {
    const found = channel.models.find((one) => one.id === model)
    if (found?.imageSizes?.length) return found.imageSizes
  }
  return undefined
}

/**
 * 前端报价统一经 `resolveImageTier`，倍率与服务端提交、结算同一来源。
 * 非 GPT 模型一律按 `gemini` 走 Gemini 的会员收口（与此前 `clampGeminiNonMemberRequest` 的口径一致）。
 */
export function tierRate(
  model: string,
  request: ImageRateRequest | null | undefined,
  entry: ImageTierEntry,
  member: boolean,
  directAvailable: boolean,
): number {
  if (!request) return 1
  return resolveImageTier({
    model,
    provider: isGptDirectModel(model) || isGptImage26Model(model) ? 'openai-compat' : 'gemini',
    request,
    entry,
    member,
    directAvailable,
    supportedTiers: declaredImageSizesForModel(model),
  }).rateMultiplier
}

/**
 * 输入框、画布门禁和草稿估价共用：按请求档，渠道没开放的档收到最近的已开放档。
 * 不按会员身份收口，等于「会员的直接提交」的报价。画布批量、分镜等入口对非会员也按这一档报价，
 * 与服务端实扣是否一致另行处理，这里保持原样。
 */
export function composerImageRate(
  model: string,
  request: ImageRateRequest | null | undefined,
): number {
  return tierRate(model, request, 'web-direct', true, true)
}

/** 阶段授权等「先收基础档再提交」的入口：和服务端 resolveImageTier 之后的倍率一致。 */
export function preparedComposerImageRate(
  model: string,
  request: ImageRateRequest | null | undefined,
  member = false,
): number {
  return tierRate(model, request, 'agent', member, true)
}

/** 基础档和渠道已收口的档位不必等待会员查询。 */
export function preparedComposerNeedsMembership(
  model: string,
  request: ImageRateRequest | null | undefined,
): boolean {
  return (
    preparedComposerImageRate(model, request, false) !==
    preparedComposerImageRate(model, request, true)
  )
}
