import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentCompactionRecord } from '@image-playground/shared'
import { log } from '../logger'
import type { CompactionBreaker, CompactionMessage, CompactionState } from './compaction'
import { shapeAgentContext } from './compaction'
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

/** pi 的契约是这个钩子不许抛：出任何岔子都把原上下文原样交回去。 */
export function createCompactionTransform(
  input: CompactionTransformInput,
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  let current: Persisted | null = null

  return async (messages) => {
    try {
      current ??= fromRecord(await loadAgentCompaction(input.conversationId))
      const result = await shapeAgentContext({
        messages: identify(messages, input),
        state: current.state,
        breaker: current.breaker,
        settings: compactionSettings(),
        now: Date.now(),
        summarize: summarizeCompaction,
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
      return messages
    }
  }
}
