import type { AgentInboxTaskResultPayload } from '@image-playground/db'
import type { AgentBatchAttemptSnapshot } from '@image-playground/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { AgentOwner } from './conversations'

/** Read only the confirmed version's durable outcomes, never prompts or image bytes. */
export async function batchWakeSummary(
  conversationId: string,
  owner: AgentOwner,
  notice: NonNullable<AgentInboxTaskResultPayload['batch']>,
): Promise<string | null> {
  if (owner.kind !== 'user' || notice.eventVersion !== 1) return null
  const [plan] = await db
    .select({
      targets: schema.agent_batch_plans.attempt_targets,
      itemCount: schema.agent_batch_plans.item_count,
    })
    .from(schema.agent_batch_plans)
    .innerJoin(schema.agent_batches, eq(schema.agent_batches.id, schema.agent_batch_plans.batch_id))
    .innerJoin(
      schema.agent_conversations,
      eq(schema.agent_conversations.id, schema.agent_batches.conversation_id),
    )
    .where(
      and(
        eq(schema.agent_batches.id, notice.batchId),
        eq(schema.agent_batches.user_id, owner.userId),
        eq(schema.agent_batches.conversation_id, conversationId),
        isNull(schema.agent_conversations.deleted_at),
        eq(schema.agent_batch_plans.version, notice.version),
      ),
    )
  if (!plan || plan.itemCount < 1 || plan.itemCount > 100) return null
  const items = schema.agent_batch_items
  const attempts = schema.agent_batch_attempts
  // Filter approved attempts in PostgreSQL: repeated retries must not load old snapshots/artifacts.
  const results = await db
    .select({
      itemKey: items.key,
      attempt: attempts.attempt,
      status: sql<
        AgentBatchAttemptSnapshot['status'] | null
      >`${attempts.terminal_snapshot} ->> 'status'`,
      actualCredits: sql<
        number | null
      >`(${attempts.terminal_snapshot} ->> 'actualCredits')::double precision`,
    })
    .from(items)
    .leftJoin(
      attempts,
      and(
        eq(attempts.batch_id, items.batch_id),
        eq(attempts.item_key, items.key),
        sql`${attempts.attempt} = COALESCE((${JSON.stringify(plan.targets)}::jsonb ->> ${items.key})::integer, 1)`,
      ),
    )
    .where(and(eq(items.batch_id, notice.batchId), eq(items.version, notice.version)))
    .orderBy(asc(items.ordinal))
    .limit(100)
  if (
    results.length !== plan.itemCount ||
    results.length !== notice.itemKeys.length ||
    results.some((result) => !result.status || !notice.itemKeys.includes(result.itemKey))
  )
    return null
  // Plan and key cardinalities are already bounded. No unbounded upstream text enters this note.
  return [
    '（系统通知，不是用户说的话）已确认批次的一版执行结果全部确定。只需简短汇总下面的执行事实，不要重新提交任务或自动发起付费复核。',
    `批次 ${notice.batchId}，版本 ${notice.version}，共 ${results.length} 项：`,
    JSON.stringify(results),
    '这里只提供任务状态和账单，没有检查产物像素，不能声称已逐图检查视觉质量。分析批次应调用 readBatchAnalysis，传入上述 batchId 和 version 分页读取已完成的真实发现，再汇总；不得把状态当成视觉结论。读取已有结果不产生新分析费用。需要补看时调用 proposeBatchAnalysis 保存明确范围的新报价，等待用户确认；需要生成时先读完有关发现再调用 proposeBatchGeneration，等待用户确认生成。',
  ].join('\n')
}
