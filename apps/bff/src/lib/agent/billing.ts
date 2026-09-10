import type { AgentTurnUsage, QuotaValues } from '@image-playground/shared'
import { config } from '../../config'
import type { TaskUsage } from '../private-overlay'

export interface ChatBillingSettings {
  /** 输出单价相对输入单价的倍数。B 档是 6 / 30，即 5 倍。 */
  readonly outputPriceRatio: number
  /** 一轮预扣多少输出 token。实际用量超过它就按预留封顶。 */
  readonly outputReserveTokens: number
}

export function chatBillingSettings(
  quotas: QuotaValues = config.operator.quotas,
): ChatBillingSettings {
  return {
    outputPriceRatio: quotas['agent:chat-output-price-ratio'],
    outputReserveTokens: quotas['agent:chat-output-reserve-tokens'],
  }
}

/**
 * 单价表的每单位积分数是正整数，装不下按千 token 的小数单价：把千 token 数塞进单位倍率，
 * 钩子里的「单价 × 数量 × 倍率后向上取整」才算得出输入 6 / 输出 30 这两档。
 */
function usageUnits(
  inputTokens: number,
  outputTokens: number,
  settings: ChatBillingSettings,
): TaskUsage {
  return {
    quantity: 1,
    unitMultiplier: (inputTokens + outputTokens * settings.outputPriceRatio) / 1_000,
  }
}

/** 预扣：输入按起轮前的估算，输出按预留上限。 */
export function reservedChatUsage(
  estimatedInputTokens: number,
  settings: ChatBillingSettings = chatBillingSettings(),
): TaskUsage {
  return usageUnits(estimatedInputTokens, settings.outputReserveTokens, settings)
}

export function actualChatUsage(
  usage: AgentTurnUsage,
  settings: ChatBillingSettings = chatBillingSettings(),
): TaskUsage {
  return usageUnits(usage.inputTokens, usage.outputTokens, settings)
}
