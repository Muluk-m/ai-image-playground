import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const cancelRoutes = new Elysia().put(
  '/v1/queue/requests/:id/cancel',
  async ({ params, status }) => {
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, params.id))
      .limit(1)

    if (!task) return status(404, { error: 'task_not_found' })
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return { request_id: task.id, status: task.status }
    }

    // queued / in_progress: 标记 cancelled。in_progress 任务的 worker 已经在 fetch
    // 上游了，目前无法中断（worker 没传 AbortController）；
    // 标记后 worker 完成时仍会写 completed/failed，覆盖 cancelled——这是已知简化，
    // 第二阶段再加 AbortController 路由到 task-runner。
    await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(eq(schema.tasks.id, params.id))

    return { request_id: task.id, status: 'cancelled' }
  },
  { params: t.Object({ id: t.String() }) },
)
