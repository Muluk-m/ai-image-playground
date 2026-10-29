import { and, eq, gte, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/** 多久以内同一会话里同模型、同提示词因 429 失败过，就不再自动重发。 */
export const RATE_LIMIT_RESEND_WINDOW_MS = 10 * 60_000

/**
 * 这一会话里，同一个模型、同一段提示词，最近是否刚因上游限流（`rate_limited`）失败过。
 *
 * 出图模式下智能体收到失败唤醒后会照原样再提交一次；限流没过去时这只会再撞一次 429，
 * 还会和别的单抢配额（2026-10-29 Lite 事故）。命中时自动提交让位给待确认的稿，
 * 要不要再跑由用户点确认决定。唤醒轮是新的 turn，所以按会话查，不按轮。
 */
export async function recentlyRateLimited(input: {
  readonly conversationId: string
  readonly model: string
  readonly prompt: string
  readonly now?: number
}): Promise<boolean> {
  const since = (input.now ?? Date.now()) - RATE_LIMIT_RESEND_WINDOW_MS
  const [hit] = await db
    .select({ id: schema.tasks.id })
    .from(schema.agent_jobs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_jobs.task_id))
    .where(
      and(
        eq(schema.agent_jobs.conversation_id, input.conversationId),
        eq(schema.tasks.model, input.model),
        eq(schema.tasks.status, 'failed'),
        eq(schema.tasks.error_type, 'rate_limited'),
        gte(schema.tasks.completed_at, since),
        sql`${schema.tasks.request_payload}->>'prompt' = ${input.prompt}`,
      ),
    )
    .limit(1)
  return hit !== undefined
}
