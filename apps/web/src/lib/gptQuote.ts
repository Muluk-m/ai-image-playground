import { clampGeminiNonMemberRequest, type ImageRateRequest } from '@image-playground/shared'
import { composerImageRate, preparedComposerImageRate } from './imageCharge'

/**
 * 按钮上的积分。`keepMemberTier` 为真时按用户选的 4K / 高画质估价（会员的直接提交）；
 * 否则按服务端会收到的非会员上限估价（非会员，以及交给智能体、阶段的请求）。
 * Gemini 先按会员身份收口，再按渠道开放档位计价。
 */
export function quotedGptMultiplier(
  model: string,
  request: ImageRateRequest | null | undefined,
  keepMemberTier: boolean,
  member = false,
): number {
  const effective = request ? clampGeminiNonMemberRequest(request, member) : request
  return keepMemberTier
    ? composerImageRate(model, effective)
    : preparedComposerImageRate(model, effective, member)
}
