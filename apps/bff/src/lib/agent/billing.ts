import type { AgentTurnUsage } from '@image-playground/shared'
import type { ChatPricing, TaskUsage } from '../private-overlay'

/** 单价表没登记这个对话模型时的兜底：预扣照样算得出，reserveTask 会以缺单价拒掉这一轮。 */
export const FALLBACK_CHAT_PRICING: ChatPricing = {
  outputPriceRatio: 5,
  outputReserveTokens: 2_000,
}

/**
 * 单价表的每单位积分数是正整数，装不下按千 token 的小数单价：把千 token 数塞进单位倍率，
 * 钩子里的「单价 × 数量 × 倍率后向上取整」才算得出输入 6 / 输出 30 这两档。
 */
function usageUnits(
  inputTokens: number,
  outputTokens: number,
  pricing: ChatPricing,
): { quantity: number; unitMultiplier: number } {
  return {
    quantity: 1,
    unitMultiplier: (inputTokens + outputTokens * pricing.outputPriceRatio) / 1_000,
  }
}

/** 预扣：输入按起轮前的估算，输出按预留上限。 */
export function reservedChatUsage(estimatedInputTokens: number, pricing: ChatPricing): TaskUsage {
  return usageUnits(estimatedInputTokens, pricing.outputReserveTokens, pricing)
}

export function actualChatUsage(usage: AgentTurnUsage, pricing: ChatPricing): TaskUsage {
  return {
    ...usageUnits(usage.inputTokens, usage.outputTokens, pricing),
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
  }
}
