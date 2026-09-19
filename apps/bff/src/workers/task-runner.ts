import { QUEUE_TIMEOUTS, type TaskErrorType } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { claimQueuedTask } from '../db/claim-task'
import { db, schema } from '../db/client'
import {
  executionContext,
  executionFence,
  TASK_HEARTBEAT_MS,
  TASK_LEASE_MS,
} from '../db/execution-context'
import {
  finishTask,
  requeueTask,
  requeueTaskArchive,
  saveArchiveCheckpoint,
} from '../db/task-transitions'
import { MaskedOutputError, protectMaskedOutput } from '../lib/agent/masked-output'
import { isCapabilityEnabled } from '../lib/capabilities'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import {
  archiveGenerationOutputs,
  generationSourceCheckpoint,
  missingGenerationOutputs,
  preserveGenerationInputs,
  spoolGenerationOutputs,
} from '../lib/generationMedia'
import {
  archiveOutputImages,
  hydrateInputImages,
  MaskedOutputArchiveError,
  ObjectStorageError,
} from '../lib/imageArchive'
import { log } from '../lib/logger'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { isAbortError } from '../lib/queueProvider'
import { isRetryableError, planNextAttempt, shouldRetryEmptyResult } from '../lib/retry'
import {
  callUpstream,
  extractUpstreamFailure,
  type UpstreamCallParams,
  UpstreamPartialResultError,
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
 *
 * abort 之后 runTask 不写任何终态：cancel route 已经自己写了 'cancelled'，停机 abort
 * 则由 worker-index 按 id 交给 recoverTasksByIds 写回可重试。
 */

const runningTasks = new Map<string, AbortController>()

/** cancel route 调用：触发对应 task 的 upstream fetch abort。返回是否找到。 */
export function abortRunningTask(id: string): boolean {
  const ctrl = runningTasks.get(id)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

/** drain 窗口耗尽时调用：abort 剩余任务。回收交给调用方，见 worker-index。 */
export function abortAllRunningTasks(): number {
  const count = runningTasks.size
  for (const ctrl of runningTasks.values()) ctrl.abort()
  return count
}

export function runningTaskIds(): string[] {
  return Array.from(runningTasks.keys())
}

/**
 * 任务「失败 / 没图」分支共享的重试调度。返回 true 表示已安排重试（调用方应 return），
 * false 表示该走终态 failed。调用方传 retryable 自己决定（按 err 还是按 payload 判）。
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
  if (!(await requeueTask(id, attemptJustFailed, plan.nextRetryAt))) return false

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

/** 记账：上游真的被调用过。终态守卫同样带 in_progress 判断。 */
async function recordUpstreamInvocation(id: string, count = 1): Promise<boolean> {
  const updated = await db
    .update(schema.tasks)
    .set({
      upstream_invocation_count: sql`${schema.tasks.upstream_invocation_count} + ${count}`,
    })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'), executionFence()))
    .returning({ id: schema.tasks.id })
  return updated.length > 0
}

async function recordUpstreamTaskIds(
  id: string,
  taskIds: readonly string[],
  anchorAlreadySet: boolean,
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      upstream_task_ids: [...taskIds],
      // 补提交缺口时不能把锚点往后推，否则重试等于领了一份新的超时预算。
      ...(anchorAlreadySet ? {} : { upstream_submitted_at: Date.now() }),
    })
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'), executionFence()))
}

export async function runTask(id: string): Promise<void> {
  return executionContext.run(executionContext.getStore() ?? crypto.randomUUID(), async () => {
    try {
      await executeTask(id)
    } catch (error) {
      await finishTask(id, {
        status: 'failed',
        errorType: 'interrupted',
        errorMessage: '任务执行异常',
        completedAt: Date.now(),
      })
      throw error
    }
  })
}

async function executeTask(id: string): Promise<void> {
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
      userId: schema.tasks.user_id,
      archive_payload: schema.tasks.archive_payload,
      attempt_count: schema.tasks.attempt_count,
      upstream_task_ids: schema.tasks.upstream_task_ids,
      upstream_submitted_at: schema.tasks.upstream_submitted_at,
      upstream_invocation_count: schema.tasks.upstream_invocation_count,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .limit(1)
  if (!task) return

  const ctrl = new AbortController()
  runningTasks.set(id, ctrl)
  let renewing = false
  const heartbeat = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      const rows = await db
        .update(schema.tasks)
        .set({ lease_expires_at: Date.now() + TASK_LEASE_MS })
        .where(
          and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress'), executionFence()),
        )
        .returning({ id: schema.tasks.id })
      if (rows.length === 0) ctrl.abort()
    } catch (error) {
      log.warn(
        { event: 'task.lease_renew_failed', taskId: id, err: String(error) },
        'task lease renewal failed',
      )
      ctrl.abort()
    } finally {
      renewing = false
    }
  }, TASK_HEARTBEAT_MS)
  log.info(
    { event: 'task.started', taskId: id, provider: task.provider, model: task.model },
    'task started',
  )

  // 已提交过的上游异步任务：接着轮，只补提交缺口，已有 id 永不重提。
  const resume =
    task.upstream_task_ids?.length && task.upstream_submitted_at !== null
      ? {
          taskIds: task.upstream_task_ids,
          invocationCount: task.upstream_invocation_count,
          submittedAt: task.upstream_submitted_at,
          pollOnly: task.upstream_invocation_count > task.upstream_task_ids.length,
        }
      : undefined

  const cloudArchive = Boolean(
    task.userId && !task.request_payload.video && isCapabilityEnabled('accounts:sync'),
  )
  let archivePayload = task.archive_payload
  let receivedImages = false
  let protectOutput: Awaited<ReturnType<typeof protectMaskedOutput>> | undefined
  try {
    if (cloudArchive && !archivePayload) {
      const preserved = await preserveGenerationInputs(id, task.request_payload)
      if (!preserved) return
      task.request_payload = preserved
    }
    const hydratedRequest = await hydrateInputImages(task.request_payload)
    // 老任务只有 preserve_outside_mask、没有 masked_original_size：那时不补边，交付时也不裁边。
    protectOutput = task.request_payload.preserve_outside_mask
      ? await protectMaskedOutput(
          hydratedRequest.input_images?.[0] ?? '',
          hydratedRequest.mask ?? '',
          task.request_payload.masked_original_size,
        )
      : undefined
    if (archivePayload) {
      archivePayload = await spoolGenerationOutputs(
        id,
        task.provider,
        archivePayload,
        protectOutput,
        ctrl.signal,
      )
      if (!(await saveArchiveCheckpoint(id, archivePayload))) return
      const missing = await missingGenerationOutputs(id, task.provider, archivePayload)
      const media = await archiveGenerationOutputs(
        task.userId!,
        task.provider,
        archivePayload,
        task.request_payload,
        missing,
      )
      await finishTask(id, {
        status: missing.size ? 'failed' : 'completed',
        ...(missing.size
          ? {
              errorType: 'upstream_result_unknown' as const,
              errorMessage: '部分原件在保存前中断，已保留可恢复的图片；不会自动重新生成',
            }
          : {}),
        media,
        resultPayload: archivePayload,
        completedAt: now(),
      })
      return
    }
    const upstreamCall: UpstreamCallParams = {
      provider: task.provider,
      model: task.model,
      request: hydratedRequest,
      signal: ctrl.signal,
      resume,
      onUpstreamTaskIds: (taskIds) => recordUpstreamTaskIds(id, taskIds, resume !== undefined),
      beforeRequest: async () => {
        if (resume && task.upstream_invocation_count > resume.taskIds.length) {
          throw new UpstreamResultUnknownError('上次提交的部分结果未知，未重复生成')
        }
        if (await recordUpstreamInvocation(id)) return
        ctrl.abort()
        throw new DOMException('Task is no longer running', 'AbortError')
      },
    }
    const { payload } = await callUpstream(upstreamCall).catch(async (error) => {
      if (
        !(error instanceof UpstreamTimeoutError) ||
        (resume && resume.submittedAt <= claimAt - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)
      )
        throw error
      const [persisted] = await db
        .select({
          ids: schema.tasks.upstream_task_ids,
          submittedAt: schema.tasks.upstream_submitted_at,
          invocationCount: schema.tasks.upstream_invocation_count,
        })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, id), executionFence()))
        .limit(1)
      if (!persisted?.ids?.length || persisted.submittedAt === null) throw error
      return callUpstream({
        ...upstreamCall,
        resume: {
          taskIds: persisted.ids,
          invocationCount: persisted.invocationCount,
          submittedAt: persisted.submittedAt,
          pollOnly: true,
        },
      })
    })
    const meta = extractMeta(task.provider, payload)
    if (meta.images.length === 0) {
      const message = describeEmptyResult(task.provider, payload)
      const attemptJustFailed = task.attempt_count + 1
      // 遮罩提交一律不自动重生成：失败就是终态，要不要再来一次由那一轮的智能体决定。
      if (
        !task.request_payload.preserve_outside_mask &&
        (await tryScheduleRetry(
          id,
          attemptJustFailed,
          shouldRetryEmptyResult(task.provider, payload),
          `no_image: ${message}`,
        ))
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
    receivedImages = true
    if (cloudArchive) {
      archivePayload = generationSourceCheckpoint(id, task.provider, payload)
      if (archivePayload) {
        try {
          if (!(await saveArchiveCheckpoint(id, archivePayload))) return
        } catch {
          // Keep the successful response alive; a checkpoint outage must not discard its bytes.
          log.warn(
            { event: 'task.checkpoint_delayed', taskId: id },
            'saving original before retrying archive checkpoint',
          )
        }
      }
    }
    const archivedPayload = cloudArchive
      ? await spoolGenerationOutputs(id, task.provider, payload, protectOutput, ctrl.signal)
      : await archiveOutputImages(id, task.provider, payload, protectOutput)
    if (cloudArchive) {
      archivePayload = archivedPayload
      if (!(await saveArchiveCheckpoint(id, archivePayload))) return
    }
    const media = cloudArchive
      ? await archiveGenerationOutputs(
          task.userId!,
          task.provider,
          archivedPayload,
          task.request_payload,
        )
      : undefined
    await finishTask(id, {
      status: 'completed',
      media,
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
    // cancel route 已经写好 'cancelled'；停机 abort 由 worker-index 按 id 回收。
    if (isAbortError(err)) {
      log.info({ event: 'task.aborted', taskId: id }, 'task aborted')
      return
    }
    if (err instanceof UpstreamPartialResultError && cloudArchive && !archivePayload) {
      archivePayload = generationSourceCheckpoint(id, task.provider, err.payload)
    }
    const rejectedMaskedOutput =
      err instanceof MaskedOutputArchiveError && err.cause instanceof MaskedOutputError
    if (archivePayload && !rejectedMaskedOutput) {
      await requeueTaskArchive(id, Date.now() + 60_000, archivePayload)
      log.warn(
        { event: 'task.archive_retry', taskId: id, err: String(err) },
        'generated output awaiting durable archive',
      )
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
    if (
      !task.request_payload.preserve_outside_mask &&
      (await tryScheduleRetry(
        id,
        attemptJustFailed,
        !(cloudArchive && receivedImages) && isRetryableError(err),
        message,
      ))
    ) {
      return
    }

    const upstream = extractUpstreamFailure(err)
    const failed = await finishTask(id, {
      status: 'failed',
      errorMessage: message,
      errorType,
      ...(err instanceof UpstreamPartialResultError
        ? {
            resultPayload: await archiveOutputImages(id, task.provider, err.payload, protectOutput),
          }
        : {}),
      ...(err instanceof MaskedOutputArchiveError
        ? {
            resultPayload: {
              masked_edit_candidates: err.candidates.map((candidate) =>
                cloudArchive ? { ...candidate, store: 'durable' } : candidate,
              ),
            },
          }
        : {}),
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
    clearInterval(heartbeat)
    runningTasks.delete(id)
  }
}
