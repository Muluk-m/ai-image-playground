import { QUEUE_TIMEOUTS, type TaskErrorType } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { claimQueuedTask } from '../db/claim-task'
import { db, schema } from '../db/client'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import { archiveOutputImages, hydrateInputImages, ObjectStorageError } from '../lib/imageArchive'
import { log } from '../lib/logger'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { isAbortError } from '../lib/queueProvider'
import { isRetryableError, planNextAttempt, shouldRetryEmptyResult } from '../lib/retry'
import {
  callUpstream,
  extractUpstreamFailure,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from '../lib/upstream'

/**
 * 单 task 后台执行：把 status 推进到 in_progress → completed/failed/cancelled。
 *
 * 只由独立 worker scheduler 调用；scheduler 负责 provider 并发与 durable retry。
 *
 * 状态写入都带 WHERE predicate（atomic claim + 终态守护）：
 * - claim：只有 status='queued' 才推到 in_progress
 * - 终态：completed/failed 写入要求 status 仍是 'in_progress'；cancel route 已经
 *   把 status 写 'cancelled' 时不会被 worker 反悔覆盖
 *
 * cancel 真打断：每个进行中的 task 在 runningTasks 里登记 AbortController；
 * scheduler 观察到数据库取消状态后调 abortRunningTask(id) 中断 fetch。
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

export function runningTaskIds(): string[] {
  return Array.from(runningTasks.keys())
}

/**
 * 任务"失败 / 没图"分支共享的重试调度。返回 true 表示已安排重试（调用方应 return），
 * false 表示该走终态 failed。调用方传 retryable 自己决定（按 err 还是按 payload 判）。
 *
 * 注意：状态回退 UPDATE 带 WHERE status='in_progress' 守卫——cancel route 已经把
 * status 改成 'cancelled' 时这里 no-op。独立 scheduler 会在 next_retry_at 到期后发现它。
 */
async function tryScheduleRetry(
  id: string,
  attemptJustFailed: number,
  retryable: boolean,
  errSummary: string,
): Promise<boolean> {
  if (!retryable) return false
  const plan = planNextAttempt(attemptJustFailed)
  if (!plan.shouldRetry) return false

  const updated = await db
    .update(schema.tasks)
    .set({
      status: 'queued',
      attempt_count: attemptJustFailed,
      next_retry_at: plan.nextRetryAt,
      // 清空临时 error / result 痕迹：retry 成功后这条 row 不该带上一次失败信息。
      // started_at 保留首次启动时间，admin 查耗时仍可用 submitted→completed。
      error_message: null,
      error_type: null,
      result_payload: null,
      upstream_status: null,
      upstream_body: null,
    })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
    .returning({ id: schema.tasks.id })
  if (updated.length === 0) return false

  log.warn(
    {
      event: 'task.retry_scheduled',
      taskId: id,
      attempt: attemptJustFailed,
      nextAttempt: attemptJustFailed + 1,
      delayMs: plan.delayMs,
      err: errSummary,
    },
    'task transient failure, scheduling retry',
  )
  return true
}
type TerminalTaskUpdate = {
  status: 'completed' | 'failed'
  completedAt: number
  resultPayload?: (typeof schema.tasks.$inferInsert)['result_payload']
  errorMessage?: string
  errorType?: TaskErrorType
  upstreamStatus?: number | null
  upstreamBody?: string | null
}

async function recordUpstreamInvocation(id: string, count = 1): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({
      upstream_invocation_count: sql`${schema.tasks.upstream_invocation_count} + ${count}`,
    })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

async function finishTask(id: string, update: TerminalTaskUpdate): Promise<boolean> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const [finished] = await tx
      .update(schema.tasks)
      .set({
        status: update.status,
        result_payload: update.resultPayload,
        error_message: update.errorMessage,
        error_type: update.errorType,
        upstream_status: update.upstreamStatus,
        upstream_body: update.upstreamBody,
        completed_at: update.completedAt,
      })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
      .returning({
        id: schema.tasks.id,
        upstreamInvocationCount: schema.tasks.upstream_invocation_count,
      })
    if (!finished) return false
    await taskHooks.finalizeTask({
      tx,
      taskId: finished.id,
      upstreamInvocationCount: finished.upstreamInvocationCount,
    })
    return true
  })
}

export async function runTask(id: string): Promise<void> {
  const now = () => Date.now()
  const claimAt = now()

  // claim 时除了 status='queued' 守卫，还要确保 next_retry_at 已到，避免 scheduler
  // 或外部误调 runTask 让等待中的重试任务提前起跑。
  if (!(await claimQueuedTask(db, id, claimAt))) return

  const [task] = await db
    .select({
      provider: schema.tasks.provider,
      model: schema.tasks.model,
      request_payload: schema.tasks.request_payload,
      attempt_count: schema.tasks.attempt_count,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .limit(1)
  if (!task) return

  const ctrl = new AbortController()
  runningTasks.set(id, ctrl)
  log.info(
    { event: 'task.started', taskId: id, provider: task.provider, model: task.model },
    'task started',
  )

  try {
    const hydratedRequest = await hydrateInputImages(task.request_payload)
    const { payload } = await callUpstream({
      provider: task.provider,
      model: task.model,
      request: hydratedRequest,
      signal: ctrl.signal,
      beforeRequest: async () => {
        if (await recordUpstreamInvocation(id)) return
        ctrl.abort()
        throw new DOMException('Task is no longer running', 'AbortError')
      },
    })
    const meta = extractMeta(task.provider, payload)
    if (meta.images.length === 0) {
      const message = describeEmptyResult(task.provider, payload)
      const attemptJustFailed = task.attempt_count + 1
      if (
        await tryScheduleRetry(
          id,
          attemptJustFailed,
          shouldRetryEmptyResult(task.provider, payload),
          `no_image: ${message}`,
        )
      ) {
        return
      }
      await finishTask(id, {
        status: 'failed',
        errorMessage: message,
        errorType: 'upstream_no_image',
        resultPayload: payload as Record<string, unknown>,
        completedAt: now(),
      })
      log.warn(
        {
          event: 'task.upstream_no_image',
          taskId: id,
          provider: task.provider,
          attempt: attemptJustFailed,
        },
        'upstream returned no image (terminal)',
      )
      return
    }
    const archivedPayload = await archiveOutputImages(id, task.provider, payload)
    await finishTask(id, {
      status: 'completed',
      resultPayload: archivedPayload,
      completedAt: now(),
    })
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
    const isUnknownResult = err instanceof UpstreamResultUnknownError
    const isStorageError = err instanceof ObjectStorageError
    const message = isTimeout
      ? `上游超时：BFF 等待超过 ${Math.round(QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS / 60000)} 分钟未拿到响应`
      : err instanceof Error
        ? err.message
        : String(err)
    const errorType: TaskErrorType = isStorageError
      ? 'object_storage_error'
      : isUnknownResult
        ? 'upstream_result_unknown'
        : 'upstream_error'

    const attemptJustFailed = task.attempt_count + 1
    if (await tryScheduleRetry(id, attemptJustFailed, isRetryableError(err), message)) {
      return
    }

    const upstream = extractUpstreamFailure(err)
    const failed = await finishTask(id, {
      status: 'failed',
      errorMessage: message,
      errorType,
      upstreamStatus: upstream.status,
      upstreamBody: upstream.body,
      completedAt: now(),
    })
    if (failed) {
      log.error(
        {
          event: 'task.failed',
          taskId: id,
          errorType,
          attempt: attemptJustFailed,
          upstreamStatus: upstream.status,
          err: message,
        },
        'task failed',
      )
    }
  } finally {
    runningTasks.delete(id)
  }
}
