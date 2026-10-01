import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentBatchGenerationProposal, AgentBatchItem } from '@image-playground/shared'
import { and, eq, inArray, lte, or } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { analysisComparison } from '../analysis-comparison'
import { readBatchSourceItems } from './batch-analysis-sources'
import { batchExecutionAvailable, lockOwnedBatch } from './batch-execution'
import { saveBatchRevision } from './batch-plan-revision'
import { BatchPlanError, sameArchivedReference } from './batch-plans'
import { resolveAgentModel } from './tools/queueTask'

/** Real completed analysis attempts supply provenance; model text never changes an older authorization. */
export async function proposeBatchGeneration(
  userId: string,
  id: string,
  input: AgentBatchGenerationProposal,
): Promise<void> {
  if (!batchExecutionAvailable(userId)) throw new BatchPlanError('batch_execution_unavailable', 422)
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ kind: 'generation_proposal', ...input }))
    .digest('hex')
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
    const permittedVersions = [
      ...new Set([
        ...(plan.confirmation?.sourceVersions ??
          (plan.confirmation?.sourceVersion ? [plan.confirmation.sourceVersion] : [])),
        plan.version,
      ]),
    ].sort((a, b) => a - b)
    const sourceVersions = input.sourceVersions
      ? [...input.sourceVersions].sort((a, b) => a - b)
      : [plan.version]
    if (!isDeepStrictEqual(sourceVersions, permittedVersions) || sourceVersions.length > 100)
      throw new BatchPlanError('batch_source_version_conflict', 409)
    const sourceItems = await readBatchSourceItems(tx, id, sourceVersions)
    const previous = sourceItems.map((source) => source.item)
    if (
      !input.items.length ||
      input.items.length > Math.min(100, config.operator.quotas['agent:batch-max-items'])
    )
      throw new BatchPlanError('batch_size_exceeded', 422)
    const sourceKeys = [...new Set(input.items.flatMap((item) => item.sourceItemKeys))]
    if (!sourceKeys.length || sourceKeys.length > 100)
      throw new BatchPlanError('invalid_batch_plan', 422)
    const attempts = await tx
      .select({
        taskId: schema.agent_batch_attempts.task_id,
        itemKey: schema.agent_batch_attempts.item_key,
        attempt: schema.agent_batch_attempts.attempt,
        result: schema.analysis_tasks,
        dispatchCount: schema.analysis_model_calls.http_dispatch_count,
        usage: schema.analysis_model_calls.usage,
      })
      .from(schema.agent_batch_attempts)
      .innerJoin(
        schema.analysis_tasks,
        eq(schema.analysis_tasks.task_id, schema.agent_batch_attempts.task_id),
      )
      .innerJoin(
        schema.analysis_model_calls,
        eq(schema.analysis_model_calls.task_id, schema.analysis_tasks.task_id),
      )
      .where(
        and(
          eq(schema.agent_batch_attempts.batch_id, id),
          or(
            ...sourceKeys.map((key) =>
              and(
                eq(schema.agent_batch_attempts.item_key, key),
                lte(
                  schema.agent_batch_attempts.version,
                  sourceItems.find((source) => source.item.key === key)?.version ?? 0,
                ),
                eq(
                  schema.agent_batch_attempts.attempt,
                  sourceItems.find((source) => source.item.key === key)?.target ?? 1,
                ),
              ),
            ),
          ),
        ),
      )
      .limit(100)
    const excludedItemKeys = input.excludedItemKeys ?? []
    const excludedImageIds = input.excludedImageIds ?? []
    const selectedImages = new Set(input.items.flatMap((item) => item.inputImageIds))
    const originalImages = new Set(
      previous.flatMap((item) => item.inputs.map((reference) => reference.imageId)),
    )
    if (
      previous.some(
        (item) =>
          item.kind !== 'analysis' ||
          (!sourceKeys.includes(item.key) && !excludedItemKeys.includes(item.key)),
      ) ||
      excludedItemKeys.some(
        (key) => sourceKeys.includes(key) || !previous.some((item) => item.key === key),
      ) ||
      excludedImageIds.some(
        (imageId) => selectedImages.has(imageId) || !originalImages.has(imageId),
      ) ||
      [...originalImages].some(
        (imageId) => !selectedImages.has(imageId) && !excludedImageIds.includes(imageId),
      )
    )
      throw new BatchPlanError('batch_scope_reduction_required', 409)
    const historicalKeys = await tx
      .select({ key: schema.agent_batch_items.key })
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          inArray(
            schema.agent_batch_items.key,
            input.items.map((item) => item.key),
          ),
        ),
      )
      .limit(100)
    const keys = new Set(historicalKeys.map((item) => item.key))
    const items: AgentBatchItem[] = []
    for (const proposed of input.items) {
      if (
        !proposed.key.trim() ||
        keys.has(proposed.key) ||
        !proposed.prompt.trim() ||
        !proposed.inputImageIds.length ||
        new Set(proposed.inputImageIds).size !== proposed.inputImageIds.length ||
        !proposed.sourceItemKeys.length ||
        new Set(proposed.sourceItemKeys).size !== proposed.sourceItemKeys.length
      )
        throw new BatchPlanError('invalid_batch_plan', 422)
      const target = resolveAgentModel('image', proposed.params.model)
      if (
        !target ||
        target.model !== proposed.params.model ||
        target.provider !== proposed.params.provider
      )
        throw new BatchPlanError('batch_execution_unavailable', 422)
      const sources = proposed.sourceItemKeys.map((key) => {
        const source = sourceItems.find((one) => one.item.key === key)
        const item = source?.item
        const attempt = attempts.find(
          (one) =>
            one.itemKey === key &&
            one.attempt === (sourceItems.find((source) => source.item.key === key)?.target ?? 1),
        )
        if (
          !item ||
          item.kind !== 'analysis' ||
          !attempt ||
          !isDeepStrictEqual(attempt.result.input_snapshot.inputs, item.inputs) ||
          (attempt.result.input_snapshot.intent ?? 'inspection') !==
            (item.params.intent ?? 'inspection') ||
          (item.params.intent === 'joint_comparison' &&
            !analysisComparison(
              attempt.result.coverage?.comparison,
              item.inputs.map((one) => one.imageId),
            )) ||
          attempt.result.status !== 'completed' ||
          attempt.result.actual_credits === null ||
          attempt.dispatchCount !== 1 ||
          !attempt.usage ||
          !attempt.result.findings ||
          !attempt.result.evidence ||
          !attempt.result.coverage ||
          attempt.result.coverage.missingImageIds.length ||
          item.inputs.some(
            (reference) =>
              !attempt.result.coverage!.reviewedImageIds.includes(reference.imageId) ||
              !attempt.result.findings!.some((finding) => finding.imageId === reference.imageId) ||
              !attempt.result.evidence!.some((evidence) => evidence.imageId === reference.imageId),
          )
        )
          throw new BatchPlanError('batch_analysis_incomplete', 409)
        return { item, attempt, version: source!.version }
      })
      const inputs = proposed.inputImageIds.map((imageId) => {
        const candidates = sources.flatMap((source) =>
          source.item.inputs.filter((reference) => reference.imageId === imageId),
        )
        const reference = candidates[0]
        if (
          !reference ||
          candidates.some((candidate) => !sameArchivedReference(reference, candidate))
        )
          throw new BatchPlanError('invalid_batch_plan', 422)
        return reference
      })
      keys.add(proposed.key)
      items.push({
        key: proposed.key,
        ordinal: items.length,
        kind: 'generation',
        inputs,
        prompt: proposed.prompt,
        params: proposed.params,
        dependencies: proposed.sourceItemKeys,
        sourceAnalysis: sources.map(({ attempt, version }) => ({
          itemKey: attempt.itemKey,
          taskId: attempt.taskId,
          attempt: attempt.attempt,
          version,
        })),
      })
    }
    await saveBatchRevision(
      tx,
      batch,
      plan,
      items,
      { id: input.commandId, kind: 'generation_proposal', requestHash },
      {
        sourceVersion: plan.version,
        ...(sourceVersions.length > 1 ? { sourceVersions } : {}),
        excludedItemKeys,
        excludedImageIds,
      },
    )
  })
}
