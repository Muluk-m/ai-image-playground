import { and, eq, inArray } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import { abortRunningTask } from '../workers/task-runner'

/**
 * PUT /v1/queue/requests/:id/cancel
 *
 * 流程：
 * 1. Atomic UPDATE 到 'cancelled'，WHERE 限定还在 queued/in_progress 才动；
 *    rowcount=0 时回 SELECT 一次决定返 404 还是当前终态
 * 2. 成功 cancel 后调 abortRunningTask(id) 触发 worker 端 AbortController；
 *    worker 的 upstream fetch 立刻 abort，sub2api 那边停止继续生成
 * 3. worker catch AbortError 后 UPDATE 'failed' 因 WHERE status='in_progress'
 *    不匹配自然 no-op，不会反悔覆盖 'cancelled'
 */
export const cancelRoutes = new Elysia().put(
  '/v1/queue/requests/:id/cancel',
  async ({ params, status }) => {
    const cancelled = await db
      .update(schema.tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(
        and(
          eq(schema.tasks.id, params.id),
          inArray(schema.tasks.status, ['queued', 'in_progress']),
        ),
      )
      .returning({ id: schema.tasks.id })

    if (cancelled.length > 0) {
      const aborted = abortRunningTask(params.id)
      log.info(
        { event: 'task.cancel_requested', taskId: params.id, abortedInflight: aborted },
        'task cancelled',
      )
      return { request_id: params.id, status: 'cancelled' as const }
    }

    const [existing] = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, params.id))
      .limit(1)

    if (!existing) return status(404, { error: 'task_not_found' })
    return { request_id: existing.id, status: existing.status }
  },
  { params: t.Object({ id: t.String() }) },
)
