import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentCompactionRecord } from '@image-playground/shared'
import type { ChatAttempt } from '../chatCompletion'
import { log } from '../logger'
import type { CompactionBreaker, CompactionMessage, CompactionState } from './compaction'
import { messageBudget, shapeAgentContext, truncateToBudget } from './compaction'
import { compactionSettings } from './compaction-settings'
import { summarizeCompaction } from './compaction-summary'
import { loadAgentCompaction, saveAgentCompaction } from './conversations'

export interface CompactionTransformInput {
  readonly conversationId: string
  readonly turnId: string
  /** 回放进 pi 的历史消息 id，顺序与上下文前缀一一对应。 */
  readonly historyIds: readonly string[]
  /** 本轮那条用户消息，紧接在历史之后。 */
  readonly userMessageId: string
  /**
   * 这一轮请求里不由消息承担的固定开销：系统说明与工具清单（见 `request-budget.ts`）。
   * 塑形要先把它让出来，否则消息刚好卡在阈值上、加上开销就超了出站硬闸。
   */
  readonly overheadTokens: number
  readonly onSummaryAttempt?: (attempt: ChatAttempt) => Promise<void>
}

interface Persisted {
  readonly state: CompactionState | null
  readonly breaker: CompactionBreaker
}

function fromRecord(record: AgentCompactionRecord | null): Persisted {
  const breaker = {
    failureCount: record?.failureCount ?? 0,
    openedAt: record?.openedAt ?? null,
  }
  if (!record?.summary || !record.anchor) return { state: null, breaker }
  return {
    state: { narrative: record.summary, anchor: record.anchor, foldCount: record.foldCount },
    breaker,
  }
}

function toRecord(current: Persisted): AgentCompactionRecord {
  return {
    summary: current.state?.narrative ?? null,
    anchor: current.state?.anchor ?? null,
    foldCount: current.state?.foldCount ?? 0,
    failureCount: current.breaker.failureCount,
    openedAt: current.breaker.openedAt,
  }
}

/**
 * pi 只给消息，不给 id。前缀按位置对回落库的那些；本轮新生成、还没落库的消息给一个带轮 id
 * 的占位——它若真被写进锚点，下一轮吻合不上就全量重做，不会把内容冻错。
 */
function identify(
  messages: readonly AgentMessage[],
  input: CompactionTransformInput,
): CompactionMessage[] {
  return messages.map((message, index) => {
    if (index < input.historyIds.length) return { id: input.historyIds[index]!, message }
    if (index === input.historyIds.length) return { id: input.userMessageId, message }
    return { id: `${input.turnId}#${index}`, message }
  })
}

function changed(next: Persisted, previous: Persisted): boolean {
  return (
    next.state !== previous.state ||
    next.breaker.failureCount !== previous.breaker.failureCount ||
    next.breaker.openedAt !== previous.breaker.openedAt
  )
}

/**
 * pi 的契约是这个钩子不许抛：出任何岔子都得交回一份能用的上下文。
 *
 * 但「能用」不等于「原样交回」。摘要失败、连接断掉、会话行没了——出岔子的那一刻历史正是
 * 最长的那一份，原样发出去必然超预算（#400 验收第 2 条：摘要失败也不能回退发送完整历史）。
 * 所以兜底走按预算截尾，超不超由 `assertRequestWithinBudget` 在出站前最后判。
 */
export function createCompactionTransform(
  input: CompactionTransformInput,
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  let current: Persisted | null = null
  // 兜底预算在这里算一次：它要在 catch 里用，而 catch 自己不能再抛。
  // 与塑形用的是同一个算式，「兜底也不超阈值」才成立。
  const fallbackBudget = messageBudget(compactionSettings(), input.overheadTokens)

  return async (messages) => {
    try {
      current ??= fromRecord(await loadAgentCompaction(input.conversationId))
      const result = await shapeAgentContext({
        messages: identify(messages, input),
        state: current.state,
        breaker: current.breaker,
        settings: compactionSettings(),
        now: Date.now(),
        overheadTokens: input.overheadTokens,
        summarize: (request) => summarizeCompaction(request, input.onSummaryAttempt),
      })

      const next: Persisted = { state: result.state, breaker: result.breaker }
      if (changed(next, current)) {
        current = next
        await saveAgentCompaction(input.conversationId, toRecord(next))
      }
      if (result.mode !== 'none') {
        log.info(
          { event: 'agent.compacted', mode: result.mode, conversationId: input.conversationId },
          'agent context compacted',
        )
      }
      return [...result.messages]
    } catch (error) {
      log.warn({ event: 'agent.compaction_failed', err: error }, 'agent compaction failed')
      return truncateToBudget(messages, fallbackBudget)
    }
  }
}
