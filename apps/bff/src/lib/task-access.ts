import { and, eq, isNull, or } from 'drizzle-orm'
import { schema } from '../db/client'

/**
 * Ownership is a row fact, not a deployment switch. Anonymous rows remain public; an owned row
 * requires the matching user even if account login is later disabled. The Admin service identity
 * bypasses only ownership and still preserves the task-ID predicate.
 */
export function taskAccessWhere(taskId: string, userId: string | null, serviceIdentity = false) {
  if (serviceIdentity) return eq(schema.tasks.id, taskId)
  return and(
    eq(schema.tasks.id, taskId),
    userId === null
      ? isNull(schema.tasks.user_id)
      : or(isNull(schema.tasks.user_id), eq(schema.tasks.user_id, userId)),
  )
}
