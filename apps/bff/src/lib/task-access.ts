import { and, eq } from 'drizzle-orm'
import { config } from '../config'
import { schema } from '../db/client'

/**
 * Account-authenticated reads require both task and user IDs. The Admin service identity can
 * bypass only that ownership predicate; callers still query the requested task and preserve 404s.
 */
export function taskAccessWhere(taskId: string, userId: string | null, serviceIdentity = false) {
  return config.auth.enabled && !serviceIdentity
    ? and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId ?? '__unauthenticated__'))
    : eq(schema.tasks.id, taskId)
}
