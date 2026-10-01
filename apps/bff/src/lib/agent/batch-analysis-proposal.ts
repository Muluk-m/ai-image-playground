import { createHash } from 'node:crypto'
import type {
  AgentBatchAnalysisItem,
  AgentBatchAnalysisProposal,
  AgentBatchItem,
} from '@image-playground/shared'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { prepareBatchAnalysis } from './batch-analysis-preparation'
import { readBatchSourceItems } from './batch-analysis-sources'
import { batchExecutionAvailable, lockOwnedBatch } from './batch-execution'
import { batchItem } from './batch-items'
import { saveBatchRevision } from './batch-plan-revision'
import { BatchPlanError, sameArchivedReference } from './batch-plans'

/** Additional paid work is a new immutable scope, never an amendment to an accepted task. */
export async function proposeBatchAnalysis(
  userId: string,
  id: string,
  input: AgentBatchAnalysisProposal,
): Promise<void> {
  if (!batchExecutionAvailable(userId) || !isCapabilityEnabled('agent:batch-analysis'))
    throw new BatchPlanError('batch_execution_unavailable', 422)
  const [owned] = await db
    .select({ id: schema.agent_batches.id })
    .from(schema.agent_batches)
    .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
  if (!owned) throw new BatchPlanError('batch_not_found', 404)
  if (!input.items.length || input.items.length > 100)
    throw new BatchPlanError('invalid_batch_plan', 422)
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ kind: 'analysis_proposal', ...input }))
    .digest('hex')
  const [existingCommand] = await db
    .select({ hash: schema.agent_batch_commands.request_hash })
    .from(schema.agent_batch_commands)
    .where(
      and(
        eq(schema.agent_batch_commands.batch_id, id),
        eq(schema.agent_batch_commands.command_id, input.commandId),
      ),
    )
  if (existingCommand) {
    if (existingCommand.hash !== requestHash)
      throw new BatchPlanError('batch_version_conflict', 409)
    return
  }
  const [current] = await db
    .select()
    .from(schema.agent_batches)
    .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
  if (
    !current ||
    current.current_version !== input.expectedVersion ||
    current.confirmed_version !== input.expectedVersion ||
    !['running', 'paused', 'closed'].includes(current.status)
  )
    throw new BatchPlanError('batch_version_conflict', 409)
  const [currentPlan] = await db
    .select()
    .from(schema.agent_batch_plans)
    .where(
      and(
        eq(schema.agent_batch_plans.batch_id, id),
        eq(schema.agent_batch_plans.version, input.expectedVersion),
      ),
    )
  if (!currentPlan) throw new BatchPlanError('batch_not_found', 404)
  const currentItems = await db
    .select()
    .from(schema.agent_batch_items)
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, id),
        eq(schema.agent_batch_items.version, input.expectedVersion),
      ),
    )
    .limit(100)
  const maxItems = Math.min(100, config.operator.quotas['agent:batch-max-items'])
  const rollover = currentItems.length + input.items.length > maxItems
  const sources = [
    ...new Set([
      ...(currentPlan.confirmation?.sourceVersions ??
        (currentPlan.confirmation?.sourceVersion ? [currentPlan.confirmation.sourceVersion] : [])),
      ...(rollover ? [currentPlan.version] : []),
    ]),
  ].sort((a, b) => a - b)
  if (sources.length > Math.min(100, config.operator.quotas['agent:batch-source-versions']))
    throw new BatchPlanError('batch_source_limit_exceeded', 422)
  const [historical] = await db
    .select({ key: schema.agent_batch_items.key })
    .from(schema.agent_batch_items)
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, id),
        inArray(
          schema.agent_batch_items.key,
          input.items.map((one) => one.key),
        ),
      ),
    )
    .limit(1)
  if (historical) throw new BatchPlanError('invalid_batch_plan', 422)
  const accepted =
    rollover && currentItems.length
      ? await db
          .select({ key: schema.agent_batch_attempts.item_key })
          .from(schema.agent_batch_attempts)
          .where(
            and(
              eq(schema.agent_batch_attempts.batch_id, id),
              or(
                ...currentItems.map((one) =>
                  and(
                    eq(schema.agent_batch_attempts.item_key, one.key),
                    eq(
                      schema.agent_batch_attempts.attempt,
                      Object.hasOwn(currentPlan.attempt_targets, one.key)
                        ? currentPlan.attempt_targets[one.key]!
                        : 1,
                    ),
                  ),
                ),
              ),
            ),
          )
          .limit(100)
      : []
  if (currentItems.length - accepted.length + input.items.length > maxItems)
    throw new BatchPlanError('batch_size_exceeded', 422)
  const archived = await readBatchSourceItems(db, id, sources)
  const selected = [...currentItems, ...archived.map((one) => one.item)]
  const references = selected.flatMap((one) => one.inputs)
  const keys = new Set(selected.map((one) => one.key))
  for (const item of input.items) {
    if (
      !item.key.trim() ||
      keys.has(item.key) ||
      !item.prompt.trim() ||
      !item.inputs.length ||
      new Set(item.inputs.map((one) => one.imageId)).size !== item.inputs.length ||
      item.dependencies.some((key) => !keys.has(key)) ||
      item.inputs.some(
        (reference) => !references.some((one) => sameArchivedReference(one, reference)),
      )
    )
      throw new BatchPlanError('invalid_batch_plan', 422)
    keys.add(item.key)
  }
  // Image I/O and transformations are deliberately outside owner/conversation/batch locks.
  const additions: AgentBatchAnalysisItem[] = []
  for (const item of input.items) {
    if (item.params.model !== config.agent.model)
      throw new BatchPlanError('batch_execution_unavailable', 422)
    const prepared = await prepareBatchAnalysis({
      userId,
      model: item.params.model,
      intent: item.params.intent,
      prompt: item.prompt,
      inputs: item.inputs,
    })
    additions.push({
      ...item,
      ordinal: 0,
      kind: 'analysis',
      params: {
        model: prepared.model,
        intent: prepared.intent,
        evidence: prepared.evidence,
        estimatedInputTokens: prepared.estimatedInputTokens,
      },
    })
  }
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    const [receipt] = await tx
      .select()
      .from(schema.agent_batch_commands)
      .where(
        and(
          eq(schema.agent_batch_commands.batch_id, id),
          eq(schema.agent_batch_commands.command_id, input.commandId),
        ),
      )
    if (receipt) {
      if (receipt.request_hash !== requestHash)
        throw new BatchPlanError('batch_version_conflict', 409)
      return
    }
    if (
      batch.current_version !== input.expectedVersion ||
      batch.confirmed_version !== input.expectedVersion ||
      !['running', 'paused', 'closed'].includes(batch.status)
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    const [plan] = await tx
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, id),
          eq(schema.agent_batch_plans.version, input.expectedVersion),
        ),
      )
    if (!plan) throw new BatchPlanError('batch_not_found', 404)
    const previous = await tx
      .select()
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, input.expectedVersion),
        ),
      )
      .orderBy(asc(schema.agent_batch_items.ordinal))
      .then((rows) => rows.map(batchItem))
    const maxItems = Math.min(100, config.operator.quotas['agent:batch-max-items'])
    const rollover = previous.length + additions.length > maxItems
    const sources = [
      ...new Set([
        ...(plan.confirmation?.sourceVersions ??
          (plan.confirmation?.sourceVersion ? [plan.confirmation.sourceVersion] : [])),
        ...(rollover ? [plan.version] : []),
      ]),
    ].sort((a, b) => a - b)
    if (sources.length > Math.min(100, config.operator.quotas['agent:batch-source-versions']))
      throw new BatchPlanError('batch_source_limit_exceeded', 422)
    const accepted = rollover
      ? await tx
          .select({ key: schema.agent_batch_attempts.item_key })
          .from(schema.agent_batch_attempts)
          .where(
            and(
              eq(schema.agent_batch_attempts.batch_id, id),
              or(
                ...previous.map((item) =>
                  and(
                    eq(schema.agent_batch_attempts.item_key, item.key),
                    eq(
                      schema.agent_batch_attempts.attempt,
                      Object.hasOwn(plan.attempt_targets, item.key)
                        ? plan.attempt_targets[item.key]!
                        : 1,
                    ),
                  ),
                ),
              ),
            ),
          )
          .limit(100)
      : []
    const carried = previous.filter((item) => !accepted.some((attempt) => attempt.key === item.key))
    if (carried.length + additions.length > maxItems)
      throw new BatchPlanError('batch_size_exceeded', 422)
    const historicalKeys = await tx
      .select({ key: schema.agent_batch_items.key })
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          inArray(
            schema.agent_batch_items.key,
            additions.map((item) => item.key),
          ),
        ),
      )
      .limit(100)
    if (historicalKeys.length) throw new BatchPlanError('invalid_batch_plan', 422)
    const archived = await readBatchSourceItems(tx, id, sources)
    const references = [...previous, ...archived.map((source) => source.item)].flatMap(
      (item) => item.inputs,
    )
    const keys = new Set([
      ...previous.map((item) => item.key),
      ...archived.map((source) => source.item.key),
    ])
    const items: AgentBatchItem[] = carried.map((item, ordinal) => ({ ...item, ordinal }))
    for (const item of additions) {
      if (
        !item.key.trim() ||
        keys.has(item.key) ||
        !item.prompt.trim() ||
        item.dependencies.some((key) => !keys.has(key)) ||
        item.inputs.some(
          (reference) => !references.some((existing) => sameArchivedReference(existing, reference)),
        )
      )
        throw new BatchPlanError('invalid_batch_plan', 422)
      keys.add(item.key)
      items.push({ ...item, ordinal: items.length })
    }
    await saveBatchRevision(
      tx,
      batch,
      plan,
      items,
      { id: input.commandId, kind: 'analysis_proposal', requestHash },
      sources.length ? { sourceVersions: sources, sourceVersion: sources.at(-1) } : {},
    )
  })
}
