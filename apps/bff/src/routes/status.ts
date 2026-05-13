import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const statusRoutes = new Elysia().get(
  '/v1/queue/requests/:id/status',
  async ({ params, status }) => {
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, params.id))
      .limit(1)

    if (!task) return status(404, { error: 'task_not_found' })

    return {
      request_id: task.id,
      status: task.status,
      submitted_at: task.submitted_at,
      ...(task.started_at !== null && task.started_at !== undefined
        ? { started_at: task.started_at }
        : {}),
      ...(task.completed_at !== null && task.completed_at !== undefined
        ? { completed_at: task.completed_at }
        : {}),
      ...(task.status === 'failed' && task.error_message
        ? {
            error: {
              message: task.error_message,
              type: task.error_type ?? 'unknown',
            },
          }
        : {}),
    }
  },
  { params: t.Object({ id: t.String() }) },
)
