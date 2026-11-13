import {
  degradeGptImage26ForSub2api,
  type Image26DegradeKind,
  type ImageRateRequest,
  isGptImage26Model,
} from '@image-playground/shared'
import {
  composerImageRate,
  directAvailableForModel,
  preparedComposerImageRate,
} from './imageCharge'

/** 按入口计算实际生效请求的倍率；直接入口的会员位由调用方传入。 */
export function quotedGptMultiplier(
  model: string,
  request: ImageRateRequest | null | undefined,
  keepMemberTier: boolean,
  member = false,
  directAvailable = directAvailableForModel(model),
): number {
  return keepMemberTier
    ? composerImageRate(model, request, member, directAvailable)
    : preparedComposerImageRate(model, request, member, directAvailable)
}

export function quotedImage26Degrade(
  model: string,
  request: ImageRateRequest | null | undefined,
  directAvailable: boolean,
) {
  if (!request || !isGptImage26Model(model) || directAvailable) return null
  return degradeGptImage26ForSub2api(request)
}

export function image26DegradeNoticeKey(kind: Image26DegradeKind) {
  switch (kind) {
    case 'size':
      return 'card.degraded.size' as const
    case 'quality':
      return 'card.degraded.quality' as const
    case 'format':
      return 'card.degraded.format' as const
    case 'size_quality':
      return 'card.degraded.size_quality' as const
    case 'size_format':
      return 'card.degraded.size_format' as const
    case 'quality_format':
      return 'card.degraded.quality_format' as const
    case 'size_quality_format':
      return 'card.degraded.size_quality_format' as const
  }
}
