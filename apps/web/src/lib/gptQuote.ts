import { clampGeminiNonMemberRequest, type ImageRateRequest } from '@image-playground/shared'
import { composerImageRate, preparedComposerImageRate } from './imageCharge'

/**
 * 按钮上的积分。`keepMemberTier` 为真时按用户选的 4K / 高画质估价（会员的直接提交）；
 * 否则按服务端会收到的非会员上限估价（非会员，以及交给智能体、阶段的请求）。
 * Gemini 先按会员身份收口，再按渠道开放档位计价。
 *
 * `keepMemberTier` 来自 `/api/gpt/premium` 的 `highQuality`：GPT 直连模型上等于「直连开着且是会员」，
 * 但 Image 2.6、Gemini 等模型恒为 true，此时 `member` 仍可能是 false，所以两者分开处理。
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
