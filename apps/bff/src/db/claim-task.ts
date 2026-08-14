import type { DbHandle } from '@image-playground/db'
import * as schema from '@image-playground/db'
import { and, eq, isNull, lte, or } from 'drizzle-orm'

export async function claimQueuedTask(
  database: DbHandle['db'],
  id: string,
  claimedAt: number,
): Promise<boolean> {
  const [claimed] = await database
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: claimedAt })
    .where(
      and(
        eq(schema.tasks.id, id),
        eq(schema.tasks.status, 'queued'),
        or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, claimedAt)),
      ),
    )
    .returning({ id: schema.tasks.id })
  return claimed !== undefined
}
