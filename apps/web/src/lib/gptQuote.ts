import type { ImageRateRequest } from '@image-playground/shared'
import { composerImageRate, preparedComposerImageRate } from './imageCharge'

/** 按入口计算实际生效请求的倍率；直接入口的会员位由调用方传入。 */
export function quotedGptMultiplier(
  model: string,
  request: ImageRateRequest | null | undefined,
  keepMemberTier: boolean,
  member = false,
  directAvailable = true,
): number {
  return keepMemberTier
    ? composerImageRate(model, request, member, directAvailable)
    : preparedComposerImageRate(model, request, member)
}
