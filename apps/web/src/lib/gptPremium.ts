import { isGptDirectModel } from '@image-playground/shared'
import { PrivateWebMembership } from './privateOverlay'

/** overlay 是否在场是构建期常量，挑一个固定的 hook 实现，不违反 hook 调用顺序。 */
const membership = PrivateWebMembership
const useSubscribed: () => boolean = membership
  ? () => membership.useMembership().subscribed
  : () => false

/**
 * GPT 直连模型的 2K、4K 与高画质只开给会员（sub2api 兑现不了）。非会员时这些选项置灰，
 * 服务端也会把越档的提交收回 1K、非高画质。`directOn` 取模型是否声明了 size：服务端只在
 * OpenAI 直连开着时声明它，没开时谁都只有基础档。
 */
export function useGptPremiumLocked(
  model: string,
  directOn: boolean,
): { locked: boolean; memberOnly: boolean } {
  const subscribed = useSubscribed()
  const gpt = isGptDirectModel(model)
  // 只有「开通会员就能用」时才提示会员专享；直连没开时会员也用不了，不拿会员说事。
  return { locked: gpt && (!subscribed || !directOn), memberOnly: gpt && directOn && !subscribed }
}
