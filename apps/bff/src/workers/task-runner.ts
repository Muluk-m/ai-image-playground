import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { callUpstream } from '../lib/upstream'

/**
 * 单 task 后台执行：把 status 推进到 in_progress → completed/failed。
 *
 * fire-and-forget；submit endpoint 不 await 此函数。
 * 简单单线程 async 模型：调 sub2api 是 localhost HTTP，BFF 进程内并发由 Bun
 * runtime 调度，不需要显式 worker pool。
 */
export async function runTask(id: string): Promise<void> {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  if (!task) return
  if (task.status !== 'queued') return // already picked up

  const now = () => Date.now()

  await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: now() })
    .where(eq(schema.tasks.id, id))

  try {
    const { payload } = await callUpstream({
      provider: task.provider,
      model: task.model,
      request: task.request_payload,
    })
    await db
      .update(schema.tasks)
      .set({
        status: 'completed',
        result_payload: payload as Record<string, unknown>,
        completed_at: now(),
      })
      .where(eq(schema.tasks.id, id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        error_message: message,
        error_type: 'upstream_error',
        completed_at: now(),
      })
      .where(eq(schema.tasks.id, id))
  }
}
