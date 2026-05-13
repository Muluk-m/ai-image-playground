import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const resultRoutes = new Elysia().get(
  '/v1/queue/requests/:id',
  async ({ params, status }) => {
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, params.id))
      .limit(1)

    if (!task) return status(404, { error: 'task_not_found' })

    if (task.status === 'completed') {
      return {
        request_id: task.id,
        status: 'completed',
        payload: task.result_payload,
      }
    }
    if (task.status === 'failed') {
      return {
        request_id: task.id,
        status: 'failed',
        error: {
          message: task.error_message ?? 'unknown',
          type: task.error_type ?? 'unknown',
        },
      }
    }
    if (task.status === 'cancelled') {
      return { request_id: task.id, status: 'cancelled' }
    }
    return status(425, { error: 'task_not_ready' })
  },
  { params: t.Object({ id: t.String() }) },
)
