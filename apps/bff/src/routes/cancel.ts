import { and, inArray } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
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
    const taskHooks = (await loadPrivateBffOverlay()).taskHooks
    const cancelled = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.tasks)
        .set({ status: 'cancelled', completed_at: Date.now() })
        .where(and(access, inArray(schema.tasks.status, ['queued', 'in_progress'])))
        .returning({
          id: schema.tasks.id,
          upstreamInvocationCount: schema.tasks.upstream_invocation_count,
        })
      for (const row of rows) {
        await taskHooks.finalizeTask({
          tx,
          taskId: row.id,
          upstreamInvocationCount: row.upstreamInvocationCount,
        })
      }
      return rows
    })

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
