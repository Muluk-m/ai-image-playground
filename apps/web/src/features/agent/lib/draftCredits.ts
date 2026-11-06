import { preparedImageRateMultiplier } from '@image-playground/shared'
import { declaredImageSizesForModel } from '../../../lib/imageCharge'
import type { PrivateSubmissionInput } from '../../../lib/privateOverlay'
import { getPrivateSubmissionGuard } from '../../../lib/privateOverlay'
import type { AgentToolMessage } from '../types'
import { agentDraftOutputCount } from './promptDraft'

/**
 * 一张待确认草稿按确认时的张数估价。估价目录不在（公开版、或这张卡没有模型）时返回
 * undefined，调用方就不写「合计约 X 积分」，避免把未知价格显示成 0。
 */
export function agentDraftCreditEstimate(
  message: AgentToolMessage,
  quote: (input: PrivateSubmissionInput) => number | undefined = (input) =>
    getPrivateSubmissionGuard(input).estimatedCredits,
  member = false,
): number | undefined {
  const model = message.snapshot?.target?.model ?? ''
  const params = message.snapshot?.params
  const estimated = quote({
    model,
    quantity: agentDraftOutputCount(message),
    unitMultiplier: preparedImageRateMultiplier(
      model,
      {
        size: params?.size,
        quality: params?.quality,
        gemini_image_size: params?.gemini_image_size,
      },
      declaredImageSizesForModel(model),
      member,
    ),
  })
  return typeof estimated === 'number' && Number.isFinite(estimated) ? estimated : undefined
}

/** 有一张估不出价，整组就不报合计。部分数字加总会让用户以为那就是全部花费。 */
export function agentPlanCreditTotal(
  messages: readonly AgentToolMessage[],
  quote?: (input: PrivateSubmissionInput) => number | undefined,
  member = false,
): number | undefined {
  if (!messages.length) return undefined
  let total = 0
  for (const message of messages) {
    const estimated = agentDraftCreditEstimate(message, quote, member)
    if (estimated === undefined) return undefined
    total += estimated
  }
  return total
}
