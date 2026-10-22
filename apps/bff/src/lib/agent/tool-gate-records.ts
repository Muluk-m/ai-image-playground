import type { AgentContentBlock, AgentToolResultBlock } from '@image-playground/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

/**
 * 确认门（见 `tool-gate.ts`）落在库里的那一半：待处理的记录就是那张 `gated` 的待确认卡，
 * 材料在 `agent_generation_drafts`。两种了结（确认、作废）都在 `confirmations.ts`，与草稿同一把会话锁。
 */

/** 作废时卡上留的那句话：给模型与日志看；界面按 `gated` 与 `cancelled` 出文案。 */
export const GATE_VOIDED_MESSAGE =
  '用户没有确认就发了新消息，这次生成已作废，没有提交任务，也没有扣费'

/** 还没了结的确认门卡，按 jsonb 包含查：卡片块里同时有这三个字段。 */
export const PENDING_GATE = sql`'[{"type":"toolResult","status":"awaiting_confirmation","gated":true}]'::jsonb`

export function isPendingGate(block: AgentContentBlock): block is AgentToolResultBlock {
  return (
    block.type === 'toolResult' && block.status === 'awaiting_confirmation' && block.gated === true
  )
}

export function pendingGateMessages(executor: typeof db | BffTransaction, conversationId: string) {
  return executor
    .select({
      id: schema.agent_messages.id,
      turnId: schema.agent_messages.turn_id,
      content: schema.agent_messages.content,
    })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
        sql`${schema.agent_messages.content} @> ${PENDING_GATE}`,
      ),
    )
}

/** 这一轮还有没了结的确认门卡吗：都确认完了才排续跑。 */
export async function turnHasPendingGate(
  tx: BffTransaction,
  conversationId: string,
  turnId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.agent_messages.id })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.turn_id, turnId),
        isNull(schema.agent_messages.deleted_at),
        sql`${schema.agent_messages.content} @> ${PENDING_GATE}`,
      ),
    )
    .limit(1)
  return row !== undefined
}
