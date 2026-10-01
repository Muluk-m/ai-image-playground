import type { TaskStatus } from '@image-playground/shared'
import { and, asc, desc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm'
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

interface DependencyItem {
  readonly key: string
  readonly dependencies: readonly string[]
}
interface DependencyTarget {
  readonly key: string
  readonly submitted: boolean
  readonly status: string | null
  readonly archived: boolean
}

/** Unsubmitted descendants of a durably cancelled target need no task or billing attempt. */
export function cancelledBatchDependents(
  items: readonly DependencyItem[],
  targets: readonly DependencyTarget[],
): Set<string> {
  const cancelled = new Set(
    targets
      .filter((target) => target.archived && target.status === 'cancelled')
      .map((target) => target.key),
  )
  const submitted = new Set(
    targets.filter((target) => target.submitted).map((target) => target.key),
  )
  const skipped = new Set<string>()
  // Plans contain at most 100 items. Iteration also handles callers whose rows aren't topological.
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false
    for (const item of items) {
      if (submitted.has(item.key) || cancelled.has(item.key)) continue
      if (!item.dependencies.some((key) => cancelled.has(key))) continue
      cancelled.add(item.key)
      skipped.add(item.key)
      changed = true
    }
    if (!changed) break
  }
  return skipped
}

/** Resolve only named dependencies in the explicitly frozen source set; current keys always win. */
export async function readFrozenDependencyTargets(
  executor: BunSQLDatabase<typeof schema> | BffTransaction,
  batchId: string,
  version: number,
  sourceVersions: readonly number[],
  items: readonly DependencyItem[],
) {
  const dependencyKeys = [...new Set(items.flatMap((item) => item.dependencies))]
  if (
    !sourceVersions.length ||
    sourceVersions.length > 100 ||
    !dependencyKeys.length ||
    items.length > 100
  )
    return []
  const item = schema.agent_batch_items
  const plan = schema.agent_batch_plans
  const attempt = schema.agent_batch_attempts
  const currentKeys = executor
    .select({ key: item.key })
    .from(item)
    .where(and(eq(item.batch_id, batchId), eq(item.version, version)))
  return executor
    .selectDistinctOn([item.key], {
      key: item.key,
      taskId: attempt.task_id,
      submitted: sql<boolean>`${attempt.task_id} IS NOT NULL`,
      archived: sql<boolean>`${attempt.terminal_snapshot} IS NOT NULL`,
      status: sql<TaskStatus>`CASE WHEN ${attempt.terminal_snapshot}->>'errorCode' = 'result_unknown' THEN 'reconciling' ELSE coalesce(${attempt.terminal_snapshot}->>'status', ${schema.tasks.status}, 'reconciling') END`,
      errorCode: sql<string | null>`${attempt.terminal_snapshot}->>'errorCode'`,
    })
    .from(item)
    .innerJoin(plan, and(eq(plan.batch_id, item.batch_id), eq(plan.version, item.version)))
    .leftJoin(
      attempt,
      and(
        eq(attempt.batch_id, item.batch_id),
        eq(attempt.item_key, item.key),
        lte(attempt.version, item.version),
        sql`${attempt.attempt} = coalesce((${plan.attempt_targets}->>${item.key})::integer, 1)`,
      ),
    )
    .leftJoin(schema.tasks, eq(schema.tasks.id, attempt.task_id))
    .where(
      and(
        eq(item.batch_id, batchId),
        inArray(item.version, [...sourceVersions]),
        inArray(item.key, dependencyKeys),
        notInArray(item.key, currentKeys),
      ),
    )
    .orderBy(asc(item.key), desc(item.version))
    .limit(dependencyKeys.length)
}
