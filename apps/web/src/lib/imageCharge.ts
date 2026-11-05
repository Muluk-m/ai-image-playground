import { type ImageRateRequest, imageRateMultiplier } from '@image-playground/shared'
import { getPublicChannels } from './channels/publicChannels'

/** 渠道明确声明的可出档。没声明就不收档，和 BFF `declaredImageSizes` 同一口径。 */
export function declaredImageSizesForModel(model: string): readonly string[] | undefined {
  for (const channel of getPublicChannels()) {
    const found = channel.models.find((one) => one.id === model)
    if (found?.imageSizes?.length) return found.imageSizes
  }
  return undefined
}

/** 输入框、画布门禁和草稿估价共用：按请求档，渠道没开放的档收到最近的已开放档。 */
export function composerImageRate(
  model: string,
  request: ImageRateRequest | null | undefined,
): number {
  return imageRateMultiplier(model, request, declaredImageSizesForModel(model))
}
