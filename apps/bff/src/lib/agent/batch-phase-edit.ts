import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentBatchItem, AgentBatchUpdate } from '@image-playground/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { prepareAnalysisTask } from '../analysis-tasks'
import { isCapabilityEnabled } from '../capabilities'
import { readBatchSourceItems } from './batch-analysis-sources'
import { lockOwnedBatch } from './batch-execution'
import { batchItem } from './batch-items'
import { saveBatchRevision } from './batch-plan-revision'
import { BatchPlanError, sameArchivedReference } from './batch-plans'
import { resolveAgentModel } from './tools/queueTask'

/** Editing pending work creates a new approval; accepted attempts retain their exact inputs and prompts. */
export async function updatePendingBatchPhase(
  userId: string,
  id: string,
  input: AgentBatchUpdate,
): Promise<boolean> {
  const [candidate] = await db
    .select({
      confirmation: schema.agent_batch_plans.confirmation,
      confirmedVersion: schema.agent_batches.confirmed_version,
      version: schema.agent_batches.current_version,
      status: schema.agent_batches.status,
    })
    .from(schema.agent_batches)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, schema.agent_batches.id),
        eq(schema.agent_batch_plans.version, schema.agent_batches.current_version),
      ),
    )
    .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
  if (!candidate?.confirmation) return false
  if (
    candidate.status !== 'paused' ||
    candidate.confirmedVersion !== null ||
    candidate.version !== input.expectedVersion
  )
    throw new BatchPlanError('batch_version_conflict', 409)
  const previous = await db
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
  const prepared = new Map<
    string,
    Omit<Awaited<ReturnType<typeof prepareAnalysisTask>>, 'images'>
  >()
  for (const item of input.items) {
    if (item.kind !== 'analysis' || !candidate.confirmation.itemKeys.includes(item.key)) continue
    if (!isCapabilityEnabled('agent:batch-analysis') || item.params.model !== config.agent.model)
      throw new BatchPlanError('batch_execution_unavailable', 422)
    const old = previous.find((one) => one.key === item.key)
    const { images: _images, ...snapshot } = await prepareAnalysisTask({
      userId,
      model: item.params.model,
      intent: item.params.intent ?? (old?.kind === 'analysis' ? old.params.intent : undefined),
      prompt: item.prompt,
      inputs: item.inputs,
    })
    prepared.set(item.key, snapshot)
  }
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    if (
      batch.current_version !== input.expectedVersion ||
      batch.status !== 'paused' ||
      batch.confirmed_version !== null
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
    if (
      !plan?.confirmation ||
      !input.title.trim() ||
      !input.rule.trim() ||
      !input.items.length ||
      input.items.length > 100
    )
      throw new BatchPlanError('invalid_batch_plan', 422)
    const attempts = await tx
      .select({
        key: schema.agent_batch_attempts.item_key,
        attempt: schema.agent_batch_attempts.attempt,
      })
      .from(schema.agent_batch_attempts)
      .where(
        and(
          eq(schema.agent_batch_attempts.batch_id, id),
          inArray(
            schema.agent_batch_attempts.item_key,
            previous.map((item) => item.key),
          ),
        ),
      )
    const accepted = new Set(
      attempts
        .filter(
          (attempt) =>
            attempt.attempt ===
            (Object.hasOwn(plan.attempt_targets, attempt.key)
              ? plan.attempt_targets[attempt.key]!
              : 1),
        )
        .map((attempt) => attempt.key),
    )
    if ([...accepted].some((key) => !input.items.some((item) => item.key === key)))
      throw new BatchPlanError('invalid_batch_plan', 422)
    const sourceIds = [
      ...new Set(
        previous.flatMap((item) =>
          item.kind === 'generation'
            ? (item.sourceAnalysis?.map((source) => source.taskId) ?? [])
            : [],
        ),
      ),
    ]
    const sources = sourceIds.length
      ? await tx
          .select({
            id: schema.analysis_tasks.task_id,
            snapshot: schema.analysis_tasks.input_snapshot,
          })
          .from(schema.analysis_tasks)
          .where(
            and(
              eq(schema.analysis_tasks.user_id, userId),
              inArray(schema.analysis_tasks.task_id, sourceIds),
            ),
          )
          .limit(100)
      : []
    const archivedSources = await readBatchSourceItems(
      tx,
      id,
      plan.confirmation.sourceVersions ??
        (plan.confirmation.sourceVersion ? [plan.confirmation.sourceVersion] : []),
    )
    const historicalDependencies = new Set(archivedSources.map((source) => source.item.key))
    const keys = new Set<string>()
    const items: AgentBatchItem[] = []
    for (const inputItem of input.items) {
      const old = previous.find((item) => item.key === inputItem.key)
      if (
        !old ||
        old.kind !== inputItem.kind ||
        keys.has(old.key) ||
        !inputItem.prompt.trim() ||
        !isDeepStrictEqual(inputItem.dependencies, old.dependencies)
      )
        throw new BatchPlanError('invalid_batch_plan', 422)
      keys.add(old.key)
      if (accepted.has(old.key)) {
        const paramsEqual =
          old.kind === 'analysis' && inputItem.kind === 'analysis'
            ? old.params.model === inputItem.params.model &&
              (old.params.intent ?? 'inspection') ===
                (inputItem.params.intent ?? old.params.intent ?? 'inspection')
            : isDeepStrictEqual(old.params, inputItem.params)
        if (
          !paramsEqual ||
          old.prompt !== inputItem.prompt ||
          !isDeepStrictEqual(old.inputs, inputItem.inputs)
        )
          throw new BatchPlanError('invalid_batch_plan', 422)
        items.push(old)
        continue
      }
      const allowed =
        old.kind === 'generation' && old.sourceAnalysis
          ? sources
              .filter((source) =>
                old.sourceAnalysis!.some((reference) => reference.taskId === source.id),
              )
              .flatMap((source) => source.snapshot.inputs)
          : previous.flatMap((item) => item.inputs)
      if (
        inputItem.inputs.some(
          (reference) => !allowed.some((original) => sameArchivedReference(original, reference)),
        )
      )
        throw new BatchPlanError('invalid_batch_plan', 422)
      if (old.kind === 'generation' && inputItem.kind === 'generation') {
        const target = resolveAgentModel('image', inputItem.params.model)
        if (
          !target ||
          target.model !== inputItem.params.model ||
          target.provider !== inputItem.params.provider
        )
          throw new BatchPlanError('batch_execution_unavailable', 422)
        items.push({
          ...old,
          inputs: inputItem.inputs,
          prompt: inputItem.prompt,
          params: inputItem.params,
        })
      } else if (old.kind === 'analysis' && inputItem.kind === 'analysis') {
        const analysis = prepared.get(old.key)
        if (!analysis) throw new BatchPlanError('invalid_batch_plan', 422)
        items.push({
          ...old,
          inputs: inputItem.inputs,
          prompt: inputItem.prompt,
          params: {
            model: analysis.model,
            intent: analysis.intent,
            estimatedInputTokens: analysis.estimatedInputTokens,
            evidence: analysis.evidence,
          },
        })
      }
    }
    if (
      items.some((item) =>
        item.dependencies.some(
          (key) =>
            !keys.has(key) &&
            !historicalDependencies.has(key) &&
            !(
              item.kind === 'generation' &&
              item.sourceAnalysis?.some((source) => source.itemKey === key)
            ),
        ),
      )
    )
      throw new BatchPlanError('invalid_batch_plan', 422)
    const retainedImages = new Set(
      items.flatMap((item) => item.inputs.map((reference) => reference.imageId)),
    )
    const excludedImageIds = [
      ...new Set([
        ...(plan.confirmation.excludedImageIds ?? []),
        ...previous.flatMap((item) => item.inputs.map((reference) => reference.imageId)),
      ]),
    ].filter((imageId) => !retainedImages.has(imageId))
    const retainedSources = new Set(
      items.flatMap((item) =>
        item.kind === 'generation'
          ? (item.sourceAnalysis?.map((source) => source.itemKey) ?? [])
          : [],
      ),
    )
    const excludedItemKeys = [
      ...new Set([
        ...(plan.confirmation.excludedItemKeys ?? []),
        ...previous
          .flatMap((item) =>
            item.kind === 'generation'
              ? (item.sourceAnalysis?.map((source) => source.itemKey) ?? [])
              : [],
          )
          .filter((key) => !retainedSources.has(key)),
      ]),
    ]
    await saveBatchRevision(
      tx,
      batch,
      { ...plan, title: input.title, rule: input.rule },
      items,
      {
        id: `edit:${crypto.randomUUID()}`,
        kind: 'phase_edit',
        requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      },
      {
        sourceVersion: plan.confirmation.sourceVersion,
        sourceVersions: plan.confirmation.sourceVersions,
        excludedItemKeys,
        excludedImageIds,
        requiresResume: plan.confirmation.requiresResume,
      },
    )
  })
  return true
}
