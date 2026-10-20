import type { AgentInboxTaskResultPayload } from '@image-playground/db'
import type {
  AgentBatchAttemptSnapshot,
  AgentBatchWakeReceipt,
  AgentToolArtifact,
} from '@image-playground/shared'
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { cancelledBatchDependents, readFrozenDependencyTargets } from './batch-dependencies'
import type { AgentOwner } from './conversations'

/** 生成批次唤醒时随这一轮附上的产物上限：与单张复核同样是视觉输入，张数多了只看前几张。 */
export const BATCH_WAKE_REVIEW_IMAGE_MAX = 6

export interface BatchWakeContent {
  readonly text: string
  /**
   * 生成项里已完成的产物，按批次顺序，最多 {@link BATCH_WAKE_REVIEW_IMAGE_MAX} 张。尽力附带：
   * 读不到或超出图片预算的会被跳过，不让整轮失败。
   */
  readonly optionalReviewImageIds: readonly string[]
}

/** Read only the confirmed version's durable outcomes, never prompts or image bytes. */
export async function batchWakeSummary(
  conversationId: string,
  owner: AgentOwner,
  notice: NonNullable<AgentInboxTaskResultPayload['batch']>,
): Promise<string | null> {
  return (await batchWakeContent(conversationId, owner, notice))?.text ?? null
}

export async function batchWakeContent(
  conversationId: string,
  owner: AgentOwner,
  notice: NonNullable<AgentInboxTaskResultPayload['batch']>,
): Promise<BatchWakeContent | null> {
  if (owner.kind !== 'user' || notice.eventVersion !== 1) return null
  const [plan] = await db
    .select({
      itemCount: schema.agent_batch_plans.item_count,
      confirmation: schema.agent_batch_plans.confirmation,
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
  const rows = await db
    .select({
      itemKey: items.key,
      kind: items.kind,
      dependencies: items.dependencies,
      taskId: attempts.task_id,
      archived: sql<boolean>`${attempts.terminal_snapshot} IS NOT NULL`,
      artifacts: sql<AgentToolArtifact[] | null>`${attempts.terminal_snapshot} -> 'artifacts'`,
      attempt: attempts.attempt,
      status: sql<
        AgentBatchAttemptSnapshot['status'] | null
      >`CASE WHEN ${attempts.terminal_snapshot}->>'errorCode' = 'result_unknown' THEN NULL ELSE ${attempts.terminal_snapshot} ->> 'status' END`,
      actualCredits: sql<
        number | null
      >`(${attempts.terminal_snapshot} ->> 'actualCredits')::double precision`,
    })
    .from(items)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, items.batch_id),
        eq(schema.agent_batch_plans.version, items.version),
      ),
    )
    .leftJoin(
      attempts,
      and(
        eq(attempts.batch_id, items.batch_id),
        eq(attempts.item_key, items.key),
        lte(attempts.version, items.version),
        sql`${attempts.attempt} = COALESCE((${schema.agent_batch_plans.attempt_targets} ->> ${items.key})::integer, 1)`,
      ),
    )
    .where(and(eq(items.batch_id, notice.batchId), eq(items.version, notice.version)))
    .orderBy(asc(items.ordinal))
    .limit(100)
  const dependencyItems = rows.map((row) => ({ key: row.itemKey, dependencies: row.dependencies }))
  const sourceTargets = await readFrozenDependencyTargets(
    db,
    notice.batchId,
    notice.version,
    plan.confirmation?.sourceVersions ??
      (plan.confirmation?.sourceVersion ? [plan.confirmation.sourceVersion] : []),
    dependencyItems,
  )
  const cancelled = cancelledBatchDependents(dependencyItems, [
    ...rows.map((row) => ({
      key: row.itemKey,
      submitted: Boolean(row.taskId),
      status: row.status,
      archived: row.archived,
    })),
    ...sourceTargets,
  ])
  const results = rows.map(
    ({
      dependencies: _dependencies,
      taskId: _taskId,
      archived: _archived,
      kind: _kind,
      artifacts: _artifacts,
      ...row
    }) =>
      cancelled.has(row.itemKey) ? { ...row, status: 'cancelled' as const, actualCredits: 0 } : row,
  )
  if (
    results.length !== plan.itemCount ||
    results.length !== notice.itemKeys.length ||
    results.some((result) => !result.status || !notice.itemKeys.includes(result.itemKey))
  )
    return null
  const generated = rows
    .filter(
      (row) =>
        row.kind === 'generation' && row.status === 'completed' && !cancelled.has(row.itemKey),
    )
    .flatMap((row) =>
      (row.artifacts ?? [])
        .filter((artifact) => artifact.media === 'image')
        .map((artifact) => artifact.artifactId),
    )
  const hasAnalysis = rows.some((row) => row.kind === 'analysis')
  const hasGeneration = rows.some((row) => row.kind === 'generation')
  const optionalReviewImageIds = generated.slice(0, BATCH_WAKE_REVIEW_IMAGE_MAX)
  const guidance: string[] = []
  if (hasGeneration)
    guidance.push(
      generated.length
        ? `生成项的产物：${generated.join('、')}。前 ${optionalReviewImageIds.length} 张会尽量作为图片随这一轮附上，实际附上哪些以本轮图片清单为准。对照用户这一批的要求逐张复核附上的图：逐项写出用户要求保留或修改的属性是否做到，不合格的指出是哪一张、哪里不对，只给修改建议，不要自行重新生成。清单里没有的产物如实说明尚未查看，可以用 viewImage 查看。`
        : '生成项没有可复核的产物：说明失败或取消的是哪几项，不要自行重新生成。',
    )
  if (hasAnalysis)
    guidance.push(
      '分析项只提供任务状态和账单，没有检查产物像素，不能把状态当成视觉结论。调用 readBatchAnalysis，传入上述 batchId 和 version 分页读取已完成的真实发现，再汇总；读取已有结果不产生新分析费用。需要补看时调用 proposeBatchAnalysis 保存明确范围的新报价，等待用户确认；需要生成时先读完有关发现再调用 proposeBatchGeneration，等待用户确认生成。',
    )
  // Plan and key cardinalities are already bounded. No unbounded upstream text enters this note.
  return {
    text: [
      '（系统通知，不是用户说的话）已确认批次的一版执行结果全部确定。汇总下面的执行事实，不要重新提交任务或自动发起付费分析。',
      `批次 ${notice.batchId}，版本 ${notice.version}，共 ${results.length} 项：`,
      JSON.stringify(results),
      ...guidance,
    ].join('\n'),
    optionalReviewImageIds,
  }
}

/** A receipt belongs to one immutable version, even when other batches share its conversation. */
export async function readBatchWakeReceipt(
  userId: string,
  batchId: string,
  version: number,
): Promise<AgentBatchWakeReceipt | null> {
  const batches = schema.agent_batches
  const plans = schema.agent_batch_plans
  const conversations = schema.agent_conversations
  const inbox = schema.agent_inbox
  const [receipt] = await db
    .select({ status: inbox.status, turnId: inbox.consumed_turn_id })
    .from(batches)
    .innerJoin(plans, and(eq(plans.batch_id, batches.id), eq(plans.version, version)))
    .innerJoin(conversations, eq(conversations.id, batches.conversation_id))
    .leftJoin(
      inbox,
      and(
        eq(inbox.conversation_id, conversations.id),
        eq(inbox.id, `batch-result:${batchId}:${version}`),
        eq(inbox.kind, 'task_result'),
      ),
    )
    .where(
      and(
        eq(batches.id, batchId),
        eq(batches.user_id, userId),
        eq(conversations.user_id, userId),
        isNull(conversations.deleted_at),
      ),
    )
  if (!receipt) return null
  if (receipt.status === 'cancelled' || receipt.status === 'failed') return { status: 'skipped' }
  if (receipt.status === 'consumed' && receipt.turnId)
    return { status: 'consumed', turnId: receipt.turnId }
  return { status: 'pending' }
}
