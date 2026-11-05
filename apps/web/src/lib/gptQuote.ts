import {
  clampGptNonMemberRequest,
  type GptTierInput,
  gptImageRateMultiplier,
} from '@image-playground/shared'

/**
 * 按钮上的积分。`keepMemberTier` 为真时按用户选的 4K / 高画质估价（会员的直接提交）；
 * 否则按服务端会收到的非会员上限估价（非会员，以及交给智能体、阶段的请求）。
 */
export function quotedGptMultiplier(
  model: string,
  request: GptTierInput,
  keepMemberTier: boolean,
): number {
  const priced = keepMemberTier ? request : clampGptNonMemberRequest(model, request)
  return gptImageRateMultiplier(model, priced)
}
