import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { cancelTasks } from '../db/task-transitions'
import { log } from '../lib/logger'
import { taskAccessWhere } from '../lib/task-access'
import { requireUser } from '../lib/user-auth'

/**
 * PUT /v1/queue/requests/:id/cancel
 *
 * The ownership predicate and cancellable states are updated atomically. The private task hook
 * finalizes any billing reservation in the same transaction. If no row matches, a final SELECT
 * distinguishes a missing task from an already terminal task.
 */
export const cancelRoutes = new Elysia().use(requireUser).put(
  '/v1/queue/requests/:id/cancel',
  async ({ params, status, authUser }) => {
    const access = taskAccessWhere(params.id, authUser?.id ?? null)
    const cancelled = await cancelTasks(access!)

    if (cancelled.length > 0) {
      log.info({ event: 'task.cancel_requested', taskId: params.id }, 'task cancelled')
      return { request_id: params.id, status: 'cancelled' as const }
    }

    const [existing] = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(access)
      .limit(1)

    if (!existing) return status(404, { error: 'task_not_found' })
    return { request_id: existing.id, status: existing.status }
  },
  { params: t.Object({ id: t.String() }) },
)
