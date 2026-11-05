import type { ImageRateRequest } from '@image-playground/shared'
import { composerImageRate, preparedComposerImageRate } from './imageCharge'

/**
 * 按钮上的积分。`keepMemberTier` 为真时按用户选的 4K / 高画质估价（会员的直接提交）；
 * 否则按服务端会收到的非会员上限估价（非会员，以及交给智能体、阶段的请求）。
 * Gemini 两种都按请求档位，渠道没开放的档收到最近的已开放档。
 */
export function quotedGptMultiplier(
  model: string,
  request: ImageRateRequest | null | undefined,
  keepMemberTier: boolean,
): number {
  return keepMemberTier
    ? composerImageRate(model, request)
    : preparedComposerImageRate(model, request)
}
