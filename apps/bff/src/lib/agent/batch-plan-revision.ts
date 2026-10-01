import { createHash } from 'node:crypto'
import type { AgentBatchConfirmation, AgentBatchItem } from '@image-playground/shared'
import { and, eq, inArray, or } from 'drizzle-orm'
import { schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'
import { batchItemValues } from './batch-items'
import { BatchPlanError, quoteBatchPlan } from './batch-plans'

/** Both paid phases commit their quote, immutable scope and confirmation barrier in one transaction. */
export async function saveBatchRevision(
  tx: BffTransaction,
  batch: typeof schema.agent_batches.$inferSelect,
  plan: typeof schema.agent_batch_plans.$inferSelect,
  items: readonly AgentBatchItem[],
  command: {
    id: string
    kind: 'analysis_proposal' | 'generation_proposal' | 'phase_edit'
    requestHash: string
  },
  provenance: Partial<
    Pick<
      AgentBatchConfirmation,
      | 'sourceVersion'
      | 'sourceVersions'
      | 'excludedItemKeys'
      | 'excludedImageIds'
      | 'requiresResume'
    >
  > = {},
): Promise<void> {
  const id = batch.id
  const userId = batch.user_id
  const attempts = await tx
    .select({
      key: schema.agent_batch_attempts.item_key,
      attempt: schema.agent_batch_attempts.attempt,
    })
    .from(schema.agent_batch_attempts)
    .where(
      and(
        eq(schema.agent_batch_attempts.batch_id, id),
        or(
          ...items.map((item) =>
            and(
              eq(schema.agent_batch_attempts.item_key, item.key),
              eq(
                schema.agent_batch_attempts.attempt,
                Object.hasOwn(plan.attempt_targets, item.key) ? plan.attempt_targets[item.key]! : 1,
              ),
            ),
          ),
        ),
      ),
    )
    .limit(100)
  const pending = items.filter(
    (item) =>
      !attempts.some(
        (attempt) =>
          attempt.key === item.key &&
          attempt.attempt ===
            (Object.hasOwn(plan.attempt_targets, item.key) ? plan.attempt_targets[item.key]! : 1),
      ),
  )
  const estimate = await quoteBatchPlan(tx, userId, pending)
  if (estimate.analysis.status !== 'available' || estimate.generation.status !== 'available')
    throw new BatchPlanError('batch_price_changed', 409)
  const kinds = new Set(pending.map((item) => item.kind))
  const confirmation: AgentBatchConfirmation = {
    phase: kinds.size === 2 ? 'mixed' : kinds.has('generation') ? 'generation' : 'analysis',
    itemKeys: pending.map((item) => item.key),
    ...provenance,
    requiresResume: provenance.requiresResume ?? batch.status === 'paused',
  }
  const mediaIds = [
    ...new Set(
      items.flatMap((item) =>
        item.inputs.flatMap((reference) => [
          reference.mediaId,
          ...(reference.maskMediaId ? [reference.maskMediaId] : []),
        ]),
      ),
    ),
  ]
  const ready = await tx
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        inArray(schema.media_objects.id, mediaIds),
      ),
    )
  if (ready.length !== mediaIds.length) throw new BatchPlanError('invalid_batch_plan', 422)
  const now = Date.now()
  const version = plan.version + 1
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        title: plan.title,
        rule: plan.rule,
        items,
        estimate,
        targets: plan.attempt_targets,
        confirmation,
      }),
    )
    .digest('hex')
  await tx.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version,
    title: plan.title,
    rule: plan.rule,
    digest,
    item_count: items.length,
    estimate_snapshot: estimate,
    attempt_targets: plan.attempt_targets,
    confirmation,
    created_at: now,
  })
  await tx
    .insert(schema.agent_batch_items)
    .values(items.map((item) => ({ ...batchItemValues(item), batch_id: id, version })))
  await tx
    .insert(schema.media_references)
    .values(
      mediaIds.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'batch' as const,
        owner_id: id,
        created_at: now,
      })),
    )
    .onConflictDoNothing()
  await tx
    .update(schema.agent_batches)
    .set({
      status: 'paused',
      current_version: version,
      confirmed_version: null,
      dispatch_generation: batch.dispatch_generation + 1,
      updated_at: now,
    })
    .where(eq(schema.agent_batches.id, id))
  await tx.insert(schema.agent_batch_commands).values({
    batch_id: id,
    command_id: command.id,
    kind: command.kind,
    request_hash: command.requestHash,
    created_at: now,
  })
}
