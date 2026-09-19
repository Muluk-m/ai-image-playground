import type { DbHandle } from '@image-playground/db'
import * as schema from '@image-playground/db'
import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { executionContext, TASK_LEASE_MS } from './execution-context'
import { publishGenerations } from './generation-events'

export async function claimQueuedTask(
  database: DbHandle['db'],
  id: string,
  claimedAt: number,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.tasks)
      .set({
        status: 'in_progress',
        started_at: claimedAt,
        execution_token: executionContext.getStore() ?? null,
        lease_expires_at: executionContext.getStore() ? claimedAt + TASK_LEASE_MS : null,
      })
      .where(
        and(
          eq(schema.tasks.id, id),
          eq(schema.tasks.status, 'queued'),
          or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, claimedAt)),
        ),
      )
      .returning({ id: schema.tasks.id })
    if (claimed) await publishGenerations(tx, [claimed.id])
    return claimed !== undefined
  })
}
