import { type AgentBatchAttemptSnapshot, taskFailureCode } from '@image-playground/shared'
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import { lockMediaOwner } from '../projectMedia'
import { queueTaskOutcome } from '../taskSubmission'
import { lockConversation } from './confirmations'
import { queueArtifacts } from './tools/queueTask'

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
  await db.transaction(async (tx) => {
    const [origin] = await tx
      .select()
      .from(schema.agent_batches)
      .where(eq(schema.agent_batches.id, batchId))
    if (!origin) return
    if (origin.conversation_id) await lockConversation(tx, origin.conversation_id, origin.user_id)
    else await lockMediaOwner(tx, origin.user_id)
    const [batch] = await tx
      .select()
      .from(schema.agent_batches)
      .where(eq(schema.agent_batches.id, batchId))
      .for('update')
    if (!batch) return
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
    if (batch.confirmed_version === null || batch.status === 'closed') return
    const items = await tx
      .select({ key: schema.agent_batch_items.key })
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, batchId),
          eq(schema.agent_batch_items.version, batch.confirmed_version),
        ),
      )
    const [plan] = await tx
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, batchId),
          eq(schema.agent_batch_plans.version, batch.confirmed_version),
        ),
      )
    const attempts = await tx
      .select({
        key: schema.agent_batch_attempts.item_key,
        attempt: schema.agent_batch_attempts.attempt,
        snapshot: schema.agent_batch_attempts.terminal_snapshot,
      })
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, batchId))
    if (
      items.length &&
      items.every((item) =>
        attempts.some(
          (attempt) =>
            attempt.key === item.key &&
            attempt.attempt ===
              (plan && Object.hasOwn(plan.attempt_targets, item.key)
                ? plan.attempt_targets[item.key]!
                : 1) &&
            attempt.snapshot,
        ),
      )
    )
      await tx
        .update(schema.agent_batches)
        .set({ status: 'closed', updated_at: Date.now() })
        .where(eq(schema.agent_batches.id, batchId))
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
