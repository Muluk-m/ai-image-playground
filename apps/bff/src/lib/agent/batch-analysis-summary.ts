import type { AgentBatchAnalysisSummary } from '@image-playground/shared'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { readBatchSourceItems } from './batch-analysis-sources'

/** Whole-plan coverage is independent of the page cursor and never needs another model call. */
export async function readBatchAnalysisSummary(
  batchId: string,
  version: number,
  itemKeys?: readonly string[],
): Promise<AgentBatchAnalysisSummary | undefined> {
  if (itemKeys?.length === 0) return undefined
  const rows = await db
    .select({
      itemKey: schema.agent_batch_items.key,
      inputs: schema.agent_batch_items.inputs,
      intent: sql<string>`coalesce(${schema.agent_batch_items.params}->>'intent', 'inspection')`,
      executedIntent: sql<string>`coalesce(${schema.analysis_tasks.input_snapshot}->>'intent', 'inspection')`,
      taskId: schema.agent_batch_attempts.task_id,
      attempt: schema.agent_batch_attempts.attempt,
      status: schema.analysis_tasks.status,
      findings: schema.analysis_tasks.findings,
      coverage: schema.analysis_tasks.coverage,
      evidence: schema.analysis_tasks.evidence,
      httpDispatchCount: schema.analysis_model_calls.http_dispatch_count,
      usage: schema.analysis_model_calls.usage,
    })
    .from(schema.agent_batch_items)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, schema.agent_batch_items.batch_id),
        eq(schema.agent_batch_plans.version, schema.agent_batch_items.version),
      ),
    )
    .leftJoin(
      schema.agent_batch_attempts,
      and(
        eq(schema.agent_batch_attempts.batch_id, schema.agent_batch_items.batch_id),
        eq(schema.agent_batch_attempts.item_key, schema.agent_batch_items.key),
        lte(schema.agent_batch_attempts.version, schema.agent_batch_items.version),
        eq(
          schema.agent_batch_attempts.attempt,
          sql<number>`coalesce((${schema.agent_batch_plans.attempt_targets} ->> ${schema.agent_batch_items.key})::integer, 1)`,
        ),
      ),
    )
    .leftJoin(
      schema.analysis_tasks,
      eq(schema.analysis_tasks.task_id, schema.agent_batch_attempts.task_id),
    )
    .leftJoin(
      schema.analysis_model_calls,
      eq(schema.analysis_model_calls.task_id, schema.analysis_tasks.task_id),
    )
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, batchId),
        eq(schema.agent_batch_items.version, version),
        eq(schema.agent_batch_items.kind, 'analysis'),
        itemKeys ? inArray(schema.agent_batch_items.key, [...itemKeys]) : undefined,
      ),
    )
    .orderBy(asc(schema.agent_batch_items.ordinal))
    .limit(100)
  if (!rows.length) return undefined
  const required = new Set<string>()
  const successful = new Set<string>()
  const unresolvedItemKeys: string[] = []
  const findings: AgentBatchAnalysisSummary['findings'][number][] = []
  const jointComparisons: AgentBatchAnalysisSummary['jointComparisons'][number][] = []
  let unresolvedInspection = false
  for (const row of rows) {
    const imageIds = row.inputs.map((input) => input.imageId)
    for (const imageId of imageIds) required.add(imageId)
    const complete = Boolean(
      row.status === 'completed' &&
        row.taskId &&
        row.attempt !== null &&
        row.intent === row.executedIntent &&
        row.httpDispatchCount === 1 &&
        row.usage !== null &&
        row.findings &&
        row.coverage &&
        row.evidence &&
        row.coverage.missingImageIds.length === 0 &&
        row.coverage.requiredImageIds.length === imageIds.length &&
        imageIds.every(
          (imageId) =>
            row.coverage!.requiredImageIds.includes(imageId) &&
            row.coverage!.reviewedImageIds.includes(imageId) &&
            row.evidence!.some((evidence) => evidence.imageId === imageId) &&
            row.findings!.filter((finding) => finding.imageId === imageId).length === 1,
        ),
    )
    if (row.intent === 'joint_comparison')
      jointComparisons.push({
        itemKey: row.itemKey,
        taskId: row.taskId,
        attempt: row.attempt,
        status: row.status ?? 'queued',
        complete,
        requiredImageIds: imageIds,
      })
    if (!complete || !row.findings || !row.evidence || !row.taskId || row.attempt === null) {
      unresolvedItemKeys.push(row.itemKey)
      if (row.intent !== 'joint_comparison') unresolvedInspection = true
      continue
    }
    for (const imageId of imageIds) {
      const finding = row.findings.find((one) => one.imageId === imageId)!
      successful.add(imageId)
      findings.push({
        ...finding,
        itemKey: row.itemKey,
        taskId: row.taskId,
        attempt: row.attempt,
        evidence: row.evidence.filter((one) => one.imageId === imageId),
      })
    }
  }
  const requiredImageIds = [...required]
  return {
    complete: unresolvedItemKeys.length === 0,
    inspectionComplete: !unresolvedInspection && requiredImageIds.every((id) => successful.has(id)),
    jointComparisons,
    requiredImageIds,
    successfulImageIds: requiredImageIds.filter((id) => successful.has(id)),
    missingImageIds: requiredImageIds.filter((id) => !successful.has(id)),
    unresolvedItemKeys,
    findings,
  }
}

/** Combine only the explicitly frozen source versions, preferring the latest authorization of each key. */
export async function readBatchSourceSummary(
  batchId: string,
  versions: readonly number[],
): Promise<AgentBatchAnalysisSummary | undefined> {
  const sources = await readBatchSourceItems(db, batchId, versions)
  const summaries: AgentBatchAnalysisSummary[] = []
  for (const version of [...new Set(versions)].sort((a, b) => a - b)) {
    const keys = sources
      .filter((source) => source.version === version && source.item.kind === 'analysis')
      .map((source) => source.item.key)
    const summary = await readBatchAnalysisSummary(batchId, version, keys)
    if (summary)
      summaries.push({
        ...summary,
        findings: summary.findings.map((finding) => ({ ...finding, version })),
      })
  }
  if (!summaries.length) return undefined
  const requiredImageIds = [...new Set(summaries.flatMap((summary) => summary.requiredImageIds))]
  const successfulImageIds = [
    ...new Set(summaries.flatMap((summary) => summary.successfulImageIds)),
  ]
  return {
    complete: summaries.every((summary) => summary.complete),
    inspectionComplete: summaries.every((summary) => summary.inspectionComplete),
    requiredImageIds,
    successfulImageIds,
    missingImageIds: requiredImageIds.filter((imageId) => !successfulImageIds.includes(imageId)),
    unresolvedItemKeys: [...new Set(summaries.flatMap((summary) => summary.unresolvedItemKeys))],
    jointComparisons: summaries.flatMap((summary) => summary.jointComparisons),
    findings: summaries.flatMap((summary) => summary.findings),
  }
}
