import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import { trackTask } from '../lib/inflight'
import { log } from '../lib/logger'
import { callUpstream } from '../lib/upstream'

/**
 * 单 task 后台执行：把 status 推进到 in_progress → completed/failed/cancelled。
 *
 * fire-and-forget；submit 端点 + 启动 recovery 都通过 spawnTask 调用。简单单线程
 * async 模型，并发由 Bun runtime 调度，无需显式 worker pool。
 *
 * 状态写入都带 WHERE predicate（atomic claim + 终态守护）：
 * - claim：只有 status='queued' 才推到 in_progress
 * - 终态：completed/failed 写入要求 status 仍是 'in_progress'；cancel route 已经
 *   把 status 写 'cancelled' 时不会被 worker 反悔覆盖
 *
 * cancel 真打断：每个进行中的 task 在 runningTasks 里登记 AbortController；
 * cancel route 调 abortRunningTask(id) 让 callUpstream 的 fetch 立刻 abort。
 */

const runningTasks = new Map<string, AbortController>()

/** cancel route 调用：触发对应 task 的 upstream fetch abort。返回是否找到。 */
export function abortRunningTask(id: string): boolean {
  const ctrl = runningTasks.get(id)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  return err instanceof Error && err.name === 'AbortError'
}

export async function runTask(id: string): Promise<void> {
  const now = () => Date.now()

  const claimed = await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: now() })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'queued')))
    .returning({ id: schema.tasks.id })
  if (claimed.length === 0) return

  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  if (!task) return

  const ctrl = new AbortController()
  runningTasks.set(id, ctrl)
  log.info({ event: 'task.started', taskId: id, provider: task.provider, model: task.model }, 'task started')

  try {
    const { payload } = await callUpstream({
      provider: task.provider,
      model: task.model,
      request: task.request_payload,
      signal: ctrl.signal,
    })
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
      log.warn({ event: 'task.upstream_no_image', taskId: id, provider: task.provider }, 'upstream returned no image')
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
    log.info({ event: 'task.completed', taskId: id, imageCount: meta.images.length }, 'task completed')
  } catch (err) {
    // AbortError = cancel route 主动 abort。cancel.ts 已经写 status='cancelled'，
    // 下面 UPDATE 因 WHERE status='in_progress' 不匹配自然 no-op。
    if (isAbortError(err)) {
      log.info({ event: 'task.cancelled', taskId: id }, 'task aborted by cancel')
      return
    }
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
    log.error({ event: 'task.failed', taskId: id, err: message }, 'task failed')
  } finally {
    runningTasks.delete(id)
  }
}

/**
 * 标准 fire-and-forget 入口：注册到 inflight 让 SIGTERM 能 drain，统一日志格式。
 */
export function spawnTask(id: string, context = 'submit'): void {
  trackTask(
    runTask(id).catch((err) => {
      log.error(
        { event: 'task.crashed', taskId: id, context, err: err instanceof Error ? err.message : String(err) },
        'task-runner crashed',
      )
    }),
  )
}
