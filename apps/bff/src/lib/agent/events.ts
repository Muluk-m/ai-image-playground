import {
  AGENT_TURN_EVENT_RETENTION_MS,
  type AgentTurnEvent,
  type AgentTurnSummaryView,
} from '@image-playground/shared'
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'

export interface StoredAgentEvent {
  readonly seq: number
  readonly event: AgentTurnEvent
}

/** 新一轮的序号从这里往后发；序号是会话内的，也就是前端看到的 `Last-Event-ID`。 */
export async function lastAgentEventSeq(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ seq: schema.agent_turn_events.seq })
    .from(schema.agent_turn_events)
    .where(eq(schema.agent_turn_events.conversation_id, conversationId))
    .orderBy(desc(schema.agent_turn_events.seq))
    .limit(1)
  return row?.seq ?? 0
}

export async function appendAgentTurnEvents(
  conversationId: string,
  turnId: string,
  events: readonly StoredAgentEvent[],
  now = Date.now(),
): Promise<void> {
  if (events.length === 0) return
  await db.insert(schema.agent_turn_events).values(
    events.map((stored) => ({
      conversation_id: conversationId,
      seq: stored.seq,
      turn_id: turnId,
      event: stored.event,
      created_at: now,
    })),
  )
}

/** 只问「有没有」：断点追平时不必把整轮的 jsonb 拉回来数长度。 */
export async function agentTurnHasEvents(conversationId: string, turnId: string): Promise<boolean> {
  const [row] = await db
    .select({ seq: schema.agent_turn_events.seq })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        eq(schema.agent_turn_events.turn_id, turnId),
      ),
    )
    .limit(1)
  return row !== undefined
}

export async function readAgentTurnEvents(
  conversationId: string,
  turnId: string,
  afterSeq: number,
): Promise<StoredAgentEvent[]> {
  const rows = await db
    .select({ seq: schema.agent_turn_events.seq, event: schema.agent_turn_events.event })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        eq(schema.agent_turn_events.turn_id, turnId),
        gt(schema.agent_turn_events.seq, afterSeq),
      ),
    )
    .orderBy(asc(schema.agent_turn_events.seq))
  return rows
}

/**
 * 翻历史时的每轮页脚：终帧本来就带耗时与消耗，不为它另存一份。
 * 代价是过了事件保留窗口的轮没有页脚。
 */
export async function listAgentTurnSummaries(
  conversationId: string,
): Promise<AgentTurnSummaryView[]> {
  const rows = await db
    .select({ event: schema.agent_turn_events.event })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        sql`${schema.agent_turn_events.event} ->> 'type' = 'turnEnd'`,
      ),
    )
    .orderBy(asc(schema.agent_turn_events.seq))
  return rows.flatMap(({ event }) => {
    if (event.type !== 'turnEnd') return []
    return [
      {
        turnId: event.turnId,
        durationMs: event.durationMs,
        stopReason: event.stopReason,
        ...(event.cost ? { cost: event.cost } : {}),
      },
    ]
  })
}

/** 保留窗口之外的事件没人再续播，留着只会把表撑大。 */
export async function purgeOldAgentTurnEvents(
  retentionMs = AGENT_TURN_EVENT_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const removed = await db
    .delete(schema.agent_turn_events)
    .where(lt(schema.agent_turn_events.created_at, now - retentionMs))
    .returning({ seq: schema.agent_turn_events.seq })
  return removed.length
}
