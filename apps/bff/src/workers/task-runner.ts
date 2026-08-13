import type { StoredSubmitRequest } from '@image-playground/db'
import {
  QUEUE_TIMEOUTS,
  type QueueProvider,
  type SubmitRequest,
  type TaskErrorType,
} from '@image-playground/shared'
import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import {
  completeTaskWithBlobs,
  resolveInputDataUrls,
  transcodeInputBlobsToWebp,
} from '../lib/blobStore'
import {
  describeEmptyResult,
  externalizeResultImages,
  extractMeta,
  markResultImagesDropped,
} from '../lib/extractImages'
import { log } from '../lib/logger'
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

async function resolveOriginalInputImages(
  taskId: string,
  request: StoredSubmitRequest,
): Promise<SubmitRequest> {
  const { input_images: inputImages, ...rest } = request
  if (!Array.isArray(inputImages)) return rest
  const resolvedImages = await resolveInputDataUrls(taskId, inputImages, db)
  return { ...rest, input_images: resolvedImages }
}

/** 终态收尾：把输入原图归档成 WebP。归档失败只记日志，不影响任务终态。 */
async function transcodeTerminalInputs(taskId: string): Promise<void> {
  try {
    await transcodeInputBlobsToWebp(taskId, db)
  } catch (error) {
    log.error(
      { event: 'task.input_archive_failed', taskId, error },
      'failed to archive terminal input images; retaining original bytes',
    )
  }
}

/**
 * 写 completed 终态。返回归档的图片数；返回 null 表示这条 row 已经不是
 * in_progress（cancel 抢先），调用方不该记 completed 日志。
 *
 * 输出 blob 与 result_payload 同事务写入；事务失败时降级成「完成但没有图」，
 * 让用户看到明确终态而不是卡在 in_progress。
 */
async function completeTask(
  taskId: string,
  provider: QueueProvider,
  upstreamPayload: unknown,
  completedAt: number,
): Promise<number | null> {
  const { payload, blobs } = externalizeResultImages(provider, upstreamPayload)
  try {
    const completed = await completeTaskWithBlobs(taskId, blobs, payload, completedAt, db)
    return completed ? extractMeta(provider, payload).images.length : null
  } catch (error) {
    log.error(
      { event: 'task.output_archive_failed', taskId, error },
      'failed to archive output images; completing with images dropped',
    )
    const updated = await db
      .update(schema.tasks)
      .set({
        status: 'completed',
        result_payload: markResultImagesDropped(payload),
        completed_at: completedAt,
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'in_progress')))
      .returning({ id: schema.tasks.id })
    return updated.length === 0 ? null : 0
  }
}

/** 写 failed 终态。返回 false 表示这条 row 已经不是 in_progress（cancel 抢先）。 */
async function failTask(
  taskId: string,
  values: {
    error_message: string
    error_type: TaskErrorType
    /** 上游 HTTP 状态与错误响应体；非 HTTP 层失败（transport / 超时）传 null。 */
    upstream_status?: number | null
    upstream_body?: string | null
    result_payload?: Record<string, unknown>
    completed_at: number
  },
): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({ status: 'failed', ...values })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'in_progress')))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

export async function runTask(id: string): Promise<void> {
  const now = () => Date.now()
  const claimAt = now()

  // claim 时除了 status='queued' 守卫，还要确保 next_retry_at 已到，避免 scheduler
  // 或外部误调 runTask 让等待中的重试任务提前起跑。
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
    const request = await resolveOriginalInputImages(id, task.request_payload)
    const { payload } = await callUpstream({
      provider: task.provider,
      model: task.model,
      request,
      signal: ctrl.signal,
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
      const failed = await failTask(id, {
        error_message: message,
        error_type: 'upstream_no_image',
        result_payload: payload as Record<string, unknown>,
        completed_at: now(),
      })
      if (failed) {
        log.warn(
          {
            event: 'task.upstream_no_image',
            taskId: id,
            provider: task.provider,
            attempt: attemptJustFailed,
          },
          'upstream returned no image (terminal)',
        )
      }
      await transcodeTerminalInputs(id)
      return
    }

    const completedImageCount = await completeTask(id, task.provider, payload, now())
    if (completedImageCount !== null) {
      log.info(
        { event: 'task.completed', taskId: id, imageCount: completedImageCount },
        'task completed',
      )
    }
    await transcodeTerminalInputs(id)
  } catch (err) {
    // AbortError = cancel route 主动 abort。cancel.ts 已经写 status='cancelled'，
    // 下面 UPDATE 因 WHERE status='in_progress' 不匹配自然 no-op。
    if (isAbortError(err)) {
      log.info({ event: 'task.cancelled', taskId: id }, 'task aborted by cancel')
      await transcodeTerminalInputs(id)
      return
    }
    const isTimeout = err instanceof UpstreamTimeoutError
    const isUnknownResult = err instanceof UpstreamResultUnknownError
    const message = isTimeout
      ? `上游超时：BFF 等待超过 ${Math.round(QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS / 60000)} 分钟未拿到响应`
      : err instanceof Error
        ? err.message
        : String(err)
    const errorType: TaskErrorType = isUnknownResult ? 'upstream_result_unknown' : 'upstream_error'

    const attemptJustFailed = task.attempt_count + 1
    if (await tryScheduleRetry(id, attemptJustFailed, isRetryableError(err), message)) {
      return
    }

    const upstream = extractUpstreamFailure(err)
    const failed = await failTask(id, {
      error_message: message,
      error_type: errorType,
      upstream_status: upstream.status,
      upstream_body: upstream.body,
      completed_at: now(),
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
    await transcodeTerminalInputs(id)
  } finally {
    runningTasks.delete(id)
  }
}
