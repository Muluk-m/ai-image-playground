import type {
  AgentTurnCost,
  AgentTurnStopReason,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { agentResumeKey } from './inbox'

const inbox = schema.agent_inbox

export interface AgentTurnSummaryRecord {
  readonly conversationId: string
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
  /** 结算后的实际消耗；不计费的部署里缺席，页脚那边只剩耗时。 */
  readonly cost?: AgentTurnCost
}

/**
 * 轮收尾时把页脚要的那几项落成持久事实。写在轮事件之外的表：事件为断线续播而存、有保留窗口，
 * 页脚要的是「这一轮花了多久、扣了多少」，它该和消息同寿命。
 *
 * 按 (会话, 轮) 幂等：同一轮重复收尾只覆盖，不堆行。
 */
export async function recordAgentTurnSummary(
  record: AgentTurnSummaryRecord,
  now = Date.now(),
): Promise<void> {
  const row = {
    conversation_id: record.conversationId,
    turn_id: record.turnId,
    duration_ms: record.durationMs,
    stop_reason: record.stopReason,
    cost: record.cost ?? null,
    created_at: now,
  }
  await db
    .insert(schema.agent_turns)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.agent_turns.conversation_id, schema.agent_turns.turn_id],
      set: { duration_ms: row.duration_ms, stop_reason: row.stop_reason, cost: row.cost },
    })
}

/** 翻历史时的每轮页脚。读这张表而不是轮事件，所以过了事件保留窗口的轮照样有页脚。 */
export async function listAgentTurnSummaries(
  conversationId: string,
): Promise<AgentTurnSummaryView[]> {
  const rows = await db
    .select({
      turnId: schema.agent_turns.turn_id,
      durationMs: schema.agent_turns.duration_ms,
      stopReason: schema.agent_turns.stop_reason,
      cost: schema.agent_turns.cost,
      createdAt: schema.agent_turns.created_at,
      // 被打断的轮排过一次中断续跑：页脚标「已中断」而不是「失败」。
      resumed: sql<boolean>`EXISTS (SELECT 1 FROM ${inbox} WHERE ${inbox.conversation_id} = ${schema.agent_turns.conversation_id} AND ${inbox.client_message_id} = ${agentResumeKey('')} || ${schema.agent_turns.turn_id})`,
    })
    .from(schema.agent_turns)
    .where(eq(schema.agent_turns.conversation_id, conversationId))
    .orderBy(asc(schema.agent_turns.created_at))
  return rows.map((row) => ({
    turnId: row.turnId,
    durationMs: row.durationMs,
    stopReason: row.stopReason,
    ...(row.stopReason === 'failed' && row.resumed
      ? { error: 'agent_turn_interrupted' as const }
      : {}),
    ...(row.cost ? { cost: row.cost } : {}),
  }))
}
