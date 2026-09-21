import type { Context } from '@earendil-works/pi-ai'
import { type CompactionSettings, compactionBudget } from './compaction'
import { estimateMessageTokens } from './token-estimate'

/**
 * 这一份出站请求现在发不发得出去。
 *
 * 与「该不该压缩」是两个问题、两个口径。触发那一侧还能拿上游报回来的用量当下界
 * （`compaction.ts` 的 `contextSizeTokens`）；**硬闸不能用那个数**——它落后一次请求：刚
 * 压缩完的那一份里，留下的助手消息带的还是压缩**之前**那次请求的用量，照它判会把一个刚
 * 瘦下来的请求判成超限。所以这里实打实地量这一份：系统说明 + 工具清单 + 每一条消息，
 * 全走字符启发式（`token-estimate.ts`），只保证同量级、略偏保守。触发那边取两个口径里
 * 大的，正是为了不让它比这道闸松——否则会出现「压缩说不用压、这里说发不出去」的死角。
 */

/** 消息与固定开销共用一条折算规则：拼成一条文本消息交给同一个估算器。 */
function textTokens(value: string): number {
  return estimateMessageTokens({
    role: 'user',
    content: [{ type: 'text', text: value }],
    timestamp: 0,
  })
}

/** 系统说明与工具清单：不是消息，却每次请求都发出去。 */
export function requestOverheadTokens(context: {
  readonly systemPrompt?: string
  readonly tools?: readonly unknown[]
}): number {
  const system = context.systemPrompt ? textTokens(context.systemPrompt) : 0
  const tools = context.tools?.length ? textTokens(JSON.stringify(context.tools)) : 0
  return system + tools
}

/** 这一份请求估出来的全部输入：固定开销加上每一条消息（图片块按 pi 的规则折算）。 */
export function requestInputTokens(context: Context): number {
  return context.messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    requestOverheadTokens(context),
  )
}

/**
 * 出站前算出来就超限。抛它而不是照发：摘要失败时历史正是最长的那一份，回退成「发完整历史」
 * 只会更超，上游那边是一个更贵、更慢、必然被拒的请求。
 */
export class AgentContextOverflow extends Error {
  constructor(
    readonly inputTokens: number,
    readonly limit: number,
  ) {
    super(`agent request needs ~${inputTokens} input tokens, over the ${limit} budget`)
    this.name = 'AgentContextOverflow'
  }
}

export function assertRequestWithinBudget(context: Context, settings: CompactionSettings): void {
  // 与压缩的阈值同源：塑形按它让预算，这里按它判整份请求，两处不会各定各的。
  const limit = compactionBudget(settings).threshold
  const inputTokens = requestInputTokens(context)
  if (inputTokens > limit) throw new AgentContextOverflow(inputTokens, limit)
}
