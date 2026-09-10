import type { AgentTurnCost } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { loadPrivateBffOverlay } from '../private-overlay'

/** 工具任务各自独立计费，只用轮 id 关联，所以本轮的账要从任务表反查再归集。 */
export async function collectTurnCost(
  conversationId: string,
  turnId: string,
): Promise<AgentTurnCost> {
  const rows = await db
    .select({
      id: schema.tasks.id,
      kind: schema.tasks.kind,
      video: sql<string | null>`${schema.tasks.request_payload} ->> 'video'`,
    })
    .from(schema.tasks)
    .where(
      and(
        // 前导列不给全就用不上 idx_tasks_agent_turn，退化成全表扫。
        eq(schema.tasks.agent_conversation_id, conversationId),
        eq(schema.tasks.agent_turn_id, turnId),
      ),
    )
  const overlay = await loadPrivateBffOverlay()
  const credits = await overlay.taskHooks.taskCredits({ taskIds: rows.map((row) => row.id) })

  const cost = { chat: 0, image: 0, video: 0 }
  for (const row of rows) {
    const bucket = row.kind === 'chat' ? 'chat' : row.video ? 'video' : 'image'
    cost[bucket] += credits[row.id] ?? 0
  }
  return cost
}
