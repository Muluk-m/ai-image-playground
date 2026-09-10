import { and, eq, isNull, or } from 'drizzle-orm'
import { schema } from '../db/client'

/**
 * Ownership is a row fact, not a deployment switch. Anonymous rows remain public; an owned row
 * requires the matching user even if account login is later disabled. The Admin service identity
 * bypasses only ownership and still preserves the task-ID predicate.
 */
export function taskAccessWhere(taskId: string, userId: string | null, serviceIdentity = false) {
  // 对话轮的 task id 就是 turnId，前端本来就拿着它；不挡住，取消端点会替它再结算一次。
  const queueTask = and(eq(schema.tasks.id, taskId), eq(schema.tasks.kind, 'queue'))
  if (serviceIdentity) return queueTask
  return and(
    queueTask,
    userId === null
      ? isNull(schema.tasks.user_id)
      : or(isNull(schema.tasks.user_id), eq(schema.tasks.user_id, userId)),
  )
}
