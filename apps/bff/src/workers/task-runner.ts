import { QUEUE_TIMEOUTS, type TaskErrorType } from '@image-playground/shared'
import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import { trackTask } from '../lib/inflight'
import { log } from '../lib/logger'
import { isAbortError } from '../lib/queueProvider'
import { isRetryableError, planNextAttempt, type RetryPlan } from '../lib/retry'
import { callUpstream, UpstreamTimeoutError } from '../lib/upstream'

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

/** SIGTERM 调用：abort 全部进行中任务，避免 drain 等满 55s 才退出。 */
export function abortAllRunningTasks(): number {
  const count = runningTasks.size
  for (const ctrl of runningTasks.values()) ctrl.abort()
  return count
}

export async function runTask(id: string): Promise<void> {
  const now = () => Date.now()
  const claimAt = now()

  // claim 时除了 status='queued' 守卫，还要确保 next_retry_at 已到——避免 setTimeout
  // 早触发 / 外部误调 spawnTask 让等待中的重试任务提前起跑。
  const claimed = await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: claimAt })
    .where(
      and(
        eq(schema.tasks.id, id),
        eq(schema.tasks.status, 'queued'),
        or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, claimAt)),
      ),
    )
    .returning({ id: schema.tasks.id })
  if (claimed.length === 0) return

  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  if (!task) return

  const ctrl = new AbortController()
  runningTasks.set(id, ctrl)
  log.info(
    { event: 'task.started', taskId: id, provider: task.provider, model: task.model },
    'task started',
  )

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
          error_type: 'upstream_no_image' as const,
          result_payload: payload as Record<string, unknown>,
          completed_at: now(),
        })
        .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
      log.warn(
        { event: 'task.upstream_no_image', taskId: id, provider: task.provider },
        'upstream returned no image',
      )
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
    log.info(
      { event: 'task.completed', taskId: id, imageCount: meta.images.length },
      'task completed',
    )
  } catch (err) {
    // AbortError = cancel route 主动 abort。cancel.ts 已经写 status='cancelled'，
    // 下面 UPDATE 因 WHERE status='in_progress' 不匹配自然 no-op。
    if (isAbortError(err)) {
      log.info({ event: 'task.cancelled', taskId: id }, 'task aborted by cancel')
      return
    }
    const isTimeout = err instanceof UpstreamTimeoutError
    const message = isTimeout
      ? `上游超时：BFF 等待超过 ${Math.round(QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS / 60000)} 分钟未拿到响应`
      : err instanceof Error
        ? err.message
        : String(err)
    const errorType: TaskErrorType = isTimeout ? 'upstream_timeout' : 'upstream_error'

    // 是否值得重试 + 是否还有 attempt 名额。两个 gate 都过才走 retry 路径，
    // 否则落终态 failed（保留终态 error_message 便于前端展示）。
    const attemptJustFailed = task.attempt_count + 1
    const plan: RetryPlan = isRetryableError(err)
      ? planNextAttempt(attemptJustFailed)
      : { shouldRetry: false }

    if (plan.shouldRetry) {
      const updated = await db
        .update(schema.tasks)
        .set({
          status: 'queued',
          attempt_count: attemptJustFailed,
          next_retry_at: plan.nextRetryAt,
          // 清空临时 error 信息：retry 成功后这条 row 不该再带上一次的失败痕迹。
          // started_at 保留首次启动时间，admin 查任务耗时分布时仍可用 submitted→completed。
          error_message: null,
          error_type: null,
        })
        .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
        .returning({ id: schema.tasks.id })
      if (updated.length > 0) {
        log.warn(
          {
            event: 'task.retry_scheduled',
            taskId: id,
            attempt: attemptJustFailed,
            nextAttempt: attemptJustFailed + 1,
            delayMs: plan.delayMs,
            err: message,
          },
          'task transient failure, scheduling retry',
        )
        // 内存里 setTimeout 调度；进程崩了下次启动 recovery 看 next_retry_at 重建。
        setTimeout(() => spawnTask(id, 'retry'), plan.delayMs)
      }
      return
    }

    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        error_message: message,
        error_type: errorType,
        completed_at: now(),
      })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
    log.error(
      {
        event: 'task.failed',
        taskId: id,
        errorType,
        attempt: attemptJustFailed,
        err: message,
      },
      'task failed',
    )
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
        {
          event: 'task.crashed',
          taskId: id,
          context,
          err: err instanceof Error ? err.message : String(err),
        },
        'task-runner crashed',
      )
    }),
  )
}
