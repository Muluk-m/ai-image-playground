import { and, eq, gte, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

interface ResendKey {
  readonly conversationId: string
  readonly model: string
  readonly prompt: string
}

/** 多久以内同一会话里同模型、同提示词因 429 失败过，就不再自动重发。 */
export const RATE_LIMIT_RESEND_WINDOW_MS = 10 * 60_000

/**
 * 这一会话里，同一个模型、同一段提示词，最近是否刚因上游限流（`rate_limited`）失败过。
 *
 * 出图模式下智能体收到失败唤醒后会照原样再提交一次；限流没过去时这只会再撞一次 429，
 * 还会和别的单抢配额（2026-10-29 Lite 事故）。命中时自动提交让位给待确认的稿，
 * 要不要再跑由用户点确认决定。唤醒轮是新的 turn，所以按会话查，不按轮。
 */
export async function recentlyRateLimited(
  input: ResendKey & { readonly now?: number },
  executor: typeof db | BffTransaction = db,
): Promise<boolean> {
  const since = (input.now ?? Date.now()) - RATE_LIMIT_RESEND_WINDOW_MS
  const [hit] = await executor
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        // 走 idx_tasks_agent_turn（会话打头）；agent_jobs 只有「未投递」的部分索引，失败的早已投递。
        eq(schema.tasks.agent_conversation_id, input.conversationId),
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

/**
 * 建任务的那个事务里做的同一道检查：先拿「会话 × 模型 × 提示词」的事务级咨询锁再查。
 * 同一份材料的并发自动提交（并发工具调用、重叠的唤醒轮）因此一前一后，检查与建任务之间
 * 没有空档；锁随事务提交释放，后一条的检查读得到此刻已提交的失败记录。
 */
export async function recentlyRateLimitedLocked(
  tx: BffTransaction,
  input: ResendKey & { readonly now?: number },
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-rate-limit-resend', input.conversationId, input.model, input.prompt])}, 0))`,
  )
  return recentlyRateLimited(input, tx)
}
