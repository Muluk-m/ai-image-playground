import { createHash } from 'node:crypto'
import type {
  AgentBatchAnalysisItem,
  AgentBatchAnalysisProposal,
  AgentBatchItem,
} from '@image-playground/shared'
import { and, asc, eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { prepareAnalysisTask } from '../analysis-tasks'
import { isCapabilityEnabled } from '../capabilities'
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
  // Image I/O and transformations are deliberately outside owner/conversation/batch locks.
  const additions: AgentBatchAnalysisItem[] = []
  for (const item of input.items) {
    if (item.params.model !== config.agent.model)
      throw new BatchPlanError('batch_execution_unavailable', 422)
    const prepared = await prepareAnalysisTask({
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
    if (
      previous.length + additions.length >
      Math.min(100, config.operator.quotas['agent:batch-max-items'])
    )
      throw new BatchPlanError('batch_size_exceeded', 422)
    const references = previous.flatMap((item) => item.inputs)
    const keys = new Set(previous.map((item) => item.key))
    const items: AgentBatchItem[] = [...previous]
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
    await saveBatchRevision(tx, batch, plan, items, {
      id: input.commandId,
      kind: 'analysis_proposal',
      requestHash,
    })
  })
}
