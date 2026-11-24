import { Elysia, t } from 'elysia'
import { log } from '../lib/logger'
import { cancelUpstreamOfCancelledTasks } from '../lib/upstream-cancel'
import { requireUser } from '../lib/user-auth'
import { cancelTasks, findAccessibleTaskState, taskAccessWhere } from '../modules/execution'

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
    const userId = authUser?.id ?? null
    const access = taskAccessWhere(params.id, userId)
    const cancelled = await cancelTasks(access!)

    if (cancelled.length > 0) {
      log.info({ event: 'task.cancel_requested', taskId: params.id }, 'task cancelled')
      void cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
      return { request_id: params.id, status: 'cancelled' as const }
    }

    const existing = await findAccessibleTaskState(params.id, userId)
    if (!existing) return status(404, { error: 'task_not_found' })
    return { request_id: existing.id, status: existing.status }
  },
  { params: t.Object({ id: t.String() }) },
)
