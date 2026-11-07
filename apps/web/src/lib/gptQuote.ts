import type { ImageRateRequest } from '@image-playground/shared'
import { preparedComposerImageRate, tierRate } from './imageCharge'

/**
 * 按钮上的积分。`keepMemberTier` 为真时按用户选的 4K / 高画质估价（会员的直接提交，
 * 即 `/api/gpt/premium` 的 `highQuality`：直连开着且是会员）；
 * 否则按服务端会收到的非会员上限估价（非会员，以及交给智能体、阶段的请求）。
 * Gemini 按会员身份收口，再按渠道开放档位计价。
 */
export function quotedGptMultiplier(
  model: string,
  request: ImageRateRequest | null | undefined,
  keepMemberTier: boolean,
  member = false,
): number {
  return keepMemberTier
    ? tierRate(model, request, 'web-direct', member, true)
    : preparedComposerImageRate(model, request, member)
}
