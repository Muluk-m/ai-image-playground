import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import { trackTask } from '../lib/inflight'
import { callUpstream } from '../lib/upstream'

/**
 * 单 task 后台执行：把 status 推进到 in_progress → completed/failed。
 *
 * fire-and-forget；submit 端点 + 启动 recovery 都通过 spawnTask 调用。简单单线程
 * async 模型，并发由 Bun runtime 调度，无需显式 worker pool。
 *
 * 所有 status 写入都带 WHERE predicate（atomic claim + 终态守护）：
 * - claim：只有 status='queued' 才推到 in_progress，防止 startup recovery 与
 *   遗留 runTask 并发时双写
 * - 终态：completed/failed 写入要求 status 仍是 'in_progress'，确保已经过 cancel
 *   推到 'cancelled' 的任务不会被 worker 反悔覆盖
 */
export async function runTask(id: string): Promise<void> {
  const now = () => Date.now()

  // Atomic claim：UPDATE 返回的行才算成功抢到执行权
  const claimed = await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: now() })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'queued')))
    .returning({ id: schema.tasks.id })
  if (claimed.length === 0) return

  // 抢到后再读完整 row 拿 provider / model / request_payload
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  if (!task) return

  try {
    const { payload } = await callUpstream({
      provider: task.provider,
      model: task.model,
      request: task.request_payload,
    })
    // 上游 HTTP 200 但实际没图（Gemini RECITATION/IMAGE_SAFETY、OpenAI body 里
    // 夹错误 envelope 等），标 failed 并把 finishReason/finishMessage 透传到前端，
    // 否则前端只看到 "BFF completed 但 images 列表为空" 这种没用的二阶信息。
    const meta = extractMeta(task.provider, payload)
    if (meta.images.length === 0) {
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          error_message: describeEmptyResult(task.provider, payload),
          error_type: 'upstream_no_image',
          result_payload: payload as Record<string, unknown>,
          completed_at: now(),
        })
        .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
      return
    }
    await db
      .update(schema.tasks)
      .set({
        status: 'completed',
        result_payload: payload as Record<string, unknown>,
        completed_at: now(),
      })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
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
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
  }
}

/**
 * 标准 fire-and-forget 入口：注册到 inflight 让 SIGTERM 能 drain，统一日志格式。
 * submit endpoint / startup recovery 都走这个，避免两边 `.catch(...) + trackTask`
 * 的微小变体漂移。
 */
export function spawnTask(id: string, context = 'submit'): void {
  trackTask(
    runTask(id).catch((err) =>
      console.error(`[task-runner ${id}] crashed (${context})`, err),
    ),
  )
}
