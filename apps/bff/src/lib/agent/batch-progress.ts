import { createHash } from 'node:crypto'
import { type AgentBatchAttemptSnapshot, taskFailureCode } from '@image-playground/shared'
import { and, asc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import { lockMediaOwner } from '../projectMedia'
import { queueTaskOutcome } from '../taskSubmission'
import { lockConversation } from './confirmations'
import { enqueueAgentWake } from './inbox'
import { queueArtifacts } from './tools/queueTask'

/** The batch lock serializes this one-time fault receipt with explicit user resume. */
export async function pauseBatchForAnalysisAuthentication(
  tx: BffTransaction,
  batch: typeof schema.agent_batches.$inferSelect,
): Promise<boolean> {
  if (batch.status !== 'running' && batch.status !== 'paused') return false
  const failures = await tx
    .select({ id: schema.tasks.id, upstreamStatus: schema.tasks.upstream_status })
    .from(schema.agent_batch_items)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, schema.agent_batch_items.batch_id),
        eq(schema.agent_batch_plans.version, schema.agent_batch_items.version),
      ),
    )
    .innerJoin(
      schema.agent_batch_attempts,
      and(
        eq(schema.agent_batch_attempts.batch_id, schema.agent_batch_items.batch_id),
        eq(schema.agent_batch_attempts.item_key, schema.agent_batch_items.key),
        eq(
          schema.agent_batch_attempts.attempt,
          sql<number>`coalesce((${schema.agent_batch_plans.attempt_targets} ->> ${schema.agent_batch_items.key})::integer, 1)`,
        ),
      ),
    )
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, batch.id),
        eq(schema.agent_batch_items.version, batch.current_version),
        eq(schema.tasks.kind, 'analysis'),
        inArray(schema.tasks.status, ['in_progress', 'reconciling', 'failed']),
        inArray(schema.tasks.upstream_status, [401, 403]),
        or(isNull(schema.tasks.error_type), ne(schema.tasks.error_type, 'content_policy')),
      ),
    )
  let freshFailure = false
  for (const failure of failures) {
    const receipt = await tx
      .insert(schema.agent_batch_commands)
      .values({
        batch_id: batch.id,
        command_id: `analysis-auth:${failure.id}`,
        kind: 'pause',
        request_hash: createHash('sha256').update(JSON.stringify(failure)).digest('hex'),
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ commandId: schema.agent_batch_commands.command_id })
    freshFailure ||= receipt.length > 0
  }
  if (!freshFailure) return false
  await tx
    .update(schema.agent_batches)
    .set({
      status: 'paused',
      pause_reason: 'upstream_auth',
      dispatch_generation: batch.dispatch_generation + 1,
      updated_at: Date.now(),
    })
    .where(eq(schema.agent_batches.id, batch.id))
  return true
}

/** Read committed settlement first: task/account locks must never acquire a batch lock. */
export async function reconcileAgentBatchProgress(batchId: string): Promise<void> {
  const rows = await db
    .select({
      task: schema.tasks,
      reservedCredits: schema.agent_batch_attempts.reserved_credits,
      price: schema.agent_batch_attempts.price_snapshot,
    })
    .from(schema.agent_batch_attempts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(
      and(
        eq(schema.agent_batch_attempts.batch_id, batchId),
        eq(schema.tasks.kind, 'queue'),
        isNull(schema.agent_batch_attempts.terminal_snapshot),
        inArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
      ),
    )
  const credits = rows.length
    ? await (await loadPrivateBffOverlay()).taskHooks.taskCredits({
        taskIds: rows.map(({ task }) => task.id),
      })
    : {}
  const snapshots = new Map<string, AgentBatchAttemptSnapshot>()
  for (const { task, reservedCredits, price } of rows) {
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled')
      continue
    const outcome = queueTaskOutcome(task)
    if (!outcome || task.completed_at === null) continue
    const charge = credits[task.id]
    const requiresBill =
      isCapabilityEnabled('billing:credits') || reservedCredits > 0 || price?.exemption === 'none'
    if (requiresBill && (!Number.isSafeInteger(charge) || charge! < 0)) continue
    snapshots.set(task.id, {
      status: task.status,
      completedAt: task.completed_at,
      upstreamStatus: task.upstream_status,
      actualCredits: Number.isSafeInteger(charge) && charge! >= 0 ? charge! : 0,
      artifacts:
        outcome.kind === 'completed' ? queueArtifacts(task.id, 'image', outcome.result) : [],
      errorCode:
        outcome.kind === 'failed'
          ? outcome.cancelled
            ? 'cancelled'
            : taskFailureCode(outcome.errorType)
          : null,
      message: outcome.kind === 'failed' ? outcome.reason : null,
    })
  }
  const analyses = await db
    .select()
    .from(schema.analysis_tasks)
    .where(
      and(
        eq(schema.analysis_tasks.batch_id, batchId),
        inArray(schema.analysis_tasks.status, ['completed', 'failed', 'cancelled']),
      ),
    )
  for (const analysis of analyses) {
    if (
      analysis.completed_at === null ||
      analysis.actual_credits === null ||
      !['completed', 'failed', 'cancelled'].includes(analysis.status)
    )
      continue
    const status = analysis.status
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') continue
    snapshots.set(analysis.task_id, {
      status,
      completedAt: analysis.completed_at,
      upstreamStatus: null,
      actualCredits: analysis.actual_credits,
      artifacts: [],
      errorCode: analysis.error_code,
      message: analysis.error_code,
      analysis: {
        findings: analysis.findings,
        coverage: analysis.coverage,
        evidence: analysis.evidence,
      },
    })
  }
  await db.transaction(async (tx) => {
    const [origin] = await tx
      .select()
      .from(schema.agent_batches)
      .where(eq(schema.agent_batches.id, batchId))
    if (!origin) return
    if (origin.conversation_id) {
      await lockConversation(tx, origin.conversation_id, origin.user_id)
      // Inbox sequence allocation shares this row lock with ordinary messages and legacy wakes.
      // Acquire it before the batch row, never from a task-finalization transaction.
      const [conversation] = await tx
        .select({ deletedAt: schema.agent_conversations.deleted_at })
        .from(schema.agent_conversations)
        .where(eq(schema.agent_conversations.id, origin.conversation_id))
        .for('update')
      if (!conversation || conversation.deletedAt) return
    } else await lockMediaOwner(tx, origin.user_id)
    const [batch] = await tx
      .select()
      .from(schema.agent_batches)
      .where(eq(schema.agent_batches.id, batchId))
      .for('update')
    if (!batch) return
    await pauseBatchForAnalysisAuthentication(tx, batch)
    let newAuthenticationFailure = false
    for (const [taskId, snapshot] of snapshots) {
      const recorded = await tx
        .update(schema.agent_batch_attempts)
        .set({ terminal_snapshot: snapshot })
        .where(
          and(
            eq(schema.agent_batch_attempts.batch_id, batchId),
            eq(schema.agent_batch_attempts.task_id, taskId),
            isNull(schema.agent_batch_attempts.terminal_snapshot),
          ),
        )
        .returning({ taskId: schema.agent_batch_attempts.task_id })
      if (
        recorded.length &&
        snapshot.status === 'failed' &&
        snapshot.errorCode !== 'content_policy' &&
        (snapshot.upstreamStatus === 401 || snapshot.upstreamStatus === 403)
      )
        newAuthenticationFailure = true
    }
    // Recording the new failure and stopping future admissions are one batch-locked transition.
    // Once a user resumes, these same archived failures do not pause the batch again.
    if (batch.status === 'running' && newAuthenticationFailure) {
      await tx
        .update(schema.agent_batches)
        .set({
          status: 'paused',
          pause_reason: 'upstream_auth',
          dispatch_generation: batch.dispatch_generation + 1,
          updated_at: Date.now(),
        })
        .where(eq(schema.agent_batches.id, batchId))
    }
    if (!batch.conversation_id) {
      await discardSettledDetachedBatch(tx, batchId)
      return
    }
    if (batch.confirmed_version === null) return
    const [plan] = await tx
      .select({
        targets: schema.agent_batch_plans.attempt_targets,
        itemCount: schema.agent_batch_plans.item_count,
      })
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, batchId),
          eq(schema.agent_batch_plans.version, batch.confirmed_version),
        ),
      )
    if (!plan || plan.itemCount < 1 || plan.itemCount > 100) return
    const items = schema.agent_batch_items
    const attempts = schema.agent_batch_attempts
    // Old attempts and artifact JSON are irrelevant to this confirmed version's completion.
    const approved = await tx
      .select({
        itemKey: items.key,
        taskId: attempts.task_id,
        terminal: sql<boolean>`${attempts.terminal_snapshot} IS NOT NULL`,
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
      .where(and(eq(items.batch_id, batchId), eq(items.version, batch.confirmed_version)))
      .orderBy(asc(items.ordinal))
      .limit(100)
    if (
      approved.length === plan.itemCount &&
      approved.every((attempt) => attempt.terminal && attempt.taskId)
    ) {
      await tx
        .update(schema.agent_batches)
        .set({ status: 'closed', updated_at: Date.now() })
        .where(eq(schema.agent_batches.id, batchId))
      await enqueueAgentWake(
        tx,
        batch.conversation_id,
        {
          turnId: batch.origin_turn_id,
          taskIds: approved.map((attempt) => attempt.taskId!),
          deviceId: batch.device_id ?? '',
          batch: {
            batchId,
            version: batch.confirmed_version,
            eventVersion: 1,
            itemKeys: approved.map((item) => item.itemKey),
          },
        },
        Date.now(),
      )
    }
  })
}

export async function snapshotAgentBatchesBeforePurge(expired: SQL): Promise<void> {
  const batches = await db
    .selectDistinct({ id: schema.agent_batch_attempts.batch_id })
    .from(schema.agent_batch_attempts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(and(expired, isNull(schema.agent_batch_attempts.terminal_snapshot)))
  for (const batch of batches) {
    try {
      await reconcileAgentBatchProgress(batch.id)
    } catch (error) {
      log.warn(
        { event: 'agent.batch_snapshot_failed', batchId: batch.id, err: String(error) },
        'batch task retained for a later snapshot',
      )
    }
  }
}

/** The caller already holds owner/conversation locks used by confirmation and deletion. */
export async function detachConversationBatches(
  conversationId: string,
  tx: BffTransaction,
): Promise<void> {
  const batches = await tx
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.conversation_id, conversationId))
    .for('update')
  for (const batch of batches) {
    await tx
      .update(schema.agent_batches)
      .set({
        conversation_id: null,
        status: batch.status === 'closed' ? 'closed' : 'paused',
        dispatch_generation: batch.dispatch_generation + 1,
        updated_at: Date.now(),
      })
      .where(eq(schema.agent_batches.id, batch.id))
    await discardSettledDetachedBatch(tx, batch.id)
  }
}

/** Deleted conversations retain execution evidence, not input pixels or abandoned instructions. */
async function discardSettledDetachedBatch(tx: BffTransaction, batchId: string): Promise<void> {
  const attempts = await tx
    .select({ snapshot: schema.agent_batch_attempts.terminal_snapshot })
    .from(schema.agent_batch_attempts)
    .where(eq(schema.agent_batch_attempts.batch_id, batchId))
  if (attempts.some((attempt) => !attempt.snapshot)) return
  const analyses = await tx
    .select()
    .from(schema.analysis_tasks)
    .where(eq(schema.analysis_tasks.batch_id, batchId))
  for (const analysis of analyses) {
    if (
      !['completed', 'failed', 'cancelled'].includes(analysis.status) ||
      analysis.actual_credits === null
    )
      continue
    await tx
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.owner_kind, 'analysis'),
          eq(schema.media_references.owner_id, analysis.task_id),
          eq(schema.media_references.user_id, analysis.user_id),
        ),
      )
    await tx
      .update(schema.analysis_tasks)
      .set({ input_snapshot: { ...analysis.input_snapshot, prompt: '', inputs: [] } })
      .where(eq(schema.analysis_tasks.task_id, analysis.task_id))
  }
  await tx
    .delete(schema.media_references)
    .where(
      and(
        eq(schema.media_references.owner_kind, 'batch'),
        eq(schema.media_references.owner_id, batchId),
      ),
    )
  await tx
    .update(schema.agent_batch_items)
    .set({ inputs: [], prompt: '' })
    .where(eq(schema.agent_batch_items.batch_id, batchId))
  await tx
    .update(schema.agent_batch_plans)
    .set({ title: '', rule: '' })
    .where(eq(schema.agent_batch_plans.batch_id, batchId))
  await tx
    .update(schema.agent_batches)
    .set({ status: 'closed', pause_reason: null, updated_at: Date.now() })
    .where(eq(schema.agent_batches.id, batchId))
}
