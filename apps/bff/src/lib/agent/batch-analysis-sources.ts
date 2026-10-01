import { and, asc, eq, inArray } from 'drizzle-orm'
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'
import { batchItem } from './batch-items'

/** Explicit version sets are bounded at the protocol boundary; never traverse parent versions. */
export async function readBatchSourceItems(
  executor: BunSQLDatabase<typeof schema> | BffTransaction,
  batchId: string,
  versions: readonly number[],
) {
  if (!versions.length || versions.length > 100) return []
  const rows = await executor
    .select({ item: schema.agent_batch_items, targets: schema.agent_batch_plans.attempt_targets })
    .from(schema.agent_batch_items)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, schema.agent_batch_items.batch_id),
        eq(schema.agent_batch_plans.version, schema.agent_batch_items.version),
      ),
    )
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, batchId),
        inArray(schema.agent_batch_items.version, [...versions]),
      ),
    )
    .orderBy(asc(schema.agent_batch_items.version), asc(schema.agent_batch_items.ordinal))
    .limit(100 * versions.length)
  const latest = new Map<
    string,
    { item: ReturnType<typeof batchItem>; version: number; target: number }
  >()
  for (const row of rows)
    latest.set(row.item.key, {
      item: batchItem(row.item),
      version: row.item.version,
      target: Object.hasOwn(row.targets, row.item.key) ? row.targets[row.item.key]! : 1,
    })
  return [...latest.values()]
}
