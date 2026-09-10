import type { AgentTurnCost } from '@image-playground/shared'
import { and, eq, ne, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { loadPrivateBffOverlay } from '../private-overlay'

/**
 * 工具任务各自独立计费，只用轮 id 关联，所以本轮的账要从任务表反查再归集。
 * 金额一律问私有账本，公开树不按单价折算：折算会与结算漂移。
 */
export async function collectTurnCost(turnId: string, chatCredits: number): Promise<AgentTurnCost> {
  const rows = await db
    .select({
      id: schema.tasks.id,
      video: sql<string | null>`${schema.tasks.request_payload} ->> 'video'`,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.agent_turn_id, turnId), ne(schema.tasks.id, turnId)))
  if (rows.length === 0) return { chat: chatCredits, image: 0, video: 0 }

  const overlay = await loadPrivateBffOverlay()
  const credits = await overlay.taskHooks.taskCredits({ taskIds: rows.map((row) => row.id) })
  let image = 0
  let video = 0
  for (const row of rows) {
    const amount = credits[row.id] ?? 0
    if (row.video) video += amount
    else image += amount
  }
  return { chat: chatCredits, image, video }
}
