import {
  degradeGptImage26ForSub2api,
  type ImageRateRequest,
  type ImageTierEntry,
  imageSizeTier,
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
/** 渠道是否声明了 GPT 直连所需的 size 能力；未声明时会员也不能保留高档参数。 */
export function directAvailableForModel(model: string): boolean {
  for (const channel of getPublicChannels()) {
    const found = channel.models.find((one) => one.id === model)
    if (found) {
      if (isGptImage26Model(model)) return found.degraded !== true
      return found.capabilities?.includes('size') ?? true
    }
  }
  return false
}

/** 2.6 直连不可用时，报价按服务端同一套 sub2api 降级来算。 */
export function billedImageRateRequest(
  model: string,
  request: ImageRateRequest | null | undefined,
  directAvailable: boolean,
): ImageRateRequest | null | undefined {
  if (!request || !isGptImage26Model(model) || directAvailable) return request
  return degradeGptImage26ForSub2api(request)?.request ?? request
}

/** 前端报价统一经 `resolveImageTier`，倍率与服务端提交、结算同一来源。 */
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
    request: billedImageRateRequest(model, request, directAvailable) ?? request,
    entry,
    member,
    directAvailable,
    supportedTiers: declaredImageSizesForModel(model),
  }).rateMultiplier
}

/** 直接提交与画布报价；画布调用方传当前会员位，避免非会员 Gemini 4K 被按会员档报价。 */
export function composerImageRate(
  model: string,
  request: ImageRateRequest | null | undefined,
  member = true,
  directAvailable = directAvailableForModel(model),
): number {
  return tierRate(model, request, 'web-direct', member, directAvailable)
}

/** 阶段授权等「先收基础档再提交」的入口：和服务端 resolveImageTier 之后的倍率一致。 */
export function preparedComposerImageRate(
  model: string,
  request: ImageRateRequest | null | undefined,
  member = false,
  directAvailable = directAvailableForModel(model),
): number {
  return tierRate(model, request, 'agent', member, directAvailable)
}

/** 基础档和渠道已收口的档位不必等待会员查询；2.6 的 4K 即使同价也仍是会员档。 */
export function preparedComposerNeedsMembership(
  model: string,
  request: ImageRateRequest | null | undefined,
): boolean {
  if (!request) return false
  const requested4K = request.image_size === '4K' || request.gemini_image_size === '4K'
  const supported = declaredImageSizesForModel(model)
  const isGemini = model.trim().toLowerCase().startsWith('gemini')
  if (requested4K && ((isGemini && supported?.includes('4K') === true) || isGptImage26Model(model)))
    return true
  if (
    (isGptDirectModel(model) || isGptImage26Model(model)) &&
    request.size !== undefined &&
    imageSizeTier(request.size) === '4K'
  )
    return true
  return resolveImageTier({
    model,
    provider: isGptDirectModel(model) || isGptImage26Model(model) ? 'openai-compat' : 'gemini',
    request,
    entry: 'agent',
    member: false,
    directAvailable: true,
    supportedTiers: supported,
  }).requires.membership
}
