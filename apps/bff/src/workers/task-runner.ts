import {
  isContentPolicyEmptyResult,
  isContentPolicyRejection,
  QUEUE_TIMEOUTS,
  type TaskErrorType,
} from '@image-playground/shared'
import { MaskedOutputError, protectMaskedOutput } from '../lib/agent/masked-output'
import { isCapabilityEnabled } from '../lib/capabilities'
import { describeEmptyResult, extractMeta } from '../lib/extractImages'
import {
  archiveGenerationOutputs,
  generationSourceCheckpoint,
  missingGenerationOutputs,
  spoolGenerationOutputs,
} from '../lib/generationMedia'
import {
  archiveOutputImages,
  hydrateInputImages,
  MaskedOutputArchiveError,
  ObjectStorageError,
} from '../lib/imageArchive'
import { log } from '../lib/logger'
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
import { claimTaskExecution, type TaskExecution } from './task-execution'

const ARCHIVE_RETRY_BUDGET_MS = 60 * 60_000

/**
 * 单 task 后台执行：把 status 推进到 in_progress → completed/failed/cancelled。
 *
 * 只由独立 worker scheduler 调用；scheduler 负责 provider 并发与 durable retry。
 *
 * 认领与写入都在执行句柄上（`task-execution.ts`）：认领成功才有句柄，这一行的每一次写
 * 都带 `status='in_progress' ∧ 本次令牌 ∧ 租约未过期`。所以 cancel route 已经把 status
 * 写成 'cancelled'、或另一个实例接手了这一行时，worker 这边一律 no-op，不会反悔覆盖。
 *
 * cancel 真打断：句柄登记在进程内的在跑表里，scheduler 观察到数据库取消状态后调
 * abortRunningTask(id) 中断 fetch；失租时句柄自己 abort。
 *
 * abort 之后 runTask 不写任何终态：cancel route 已经自己写了 'cancelled'，停机 abort
 * 则由 worker-index 按 id 交给 recoverTasksByIds 写回可重试。
 */

/**
 * 任务「失败 / 没图」分支共享的重试调度。返回 true 表示已安排重试（调用方应 return），
 * false 表示该走终态 failed。调用方传 retryable 自己决定（按 err 还是按 payload 判）。
 */
async function tryScheduleRetry(
  execution: TaskExecution,
  attemptJustFailed: number,
  retryable: boolean,
  errSummary: string,
): Promise<boolean> {
  if (!retryable) return false
  const plan = planNextAttempt(attemptJustFailed)
  if (!plan.shouldRetry) return false
  if (!(await execution.requeue(attemptJustFailed, plan.nextRetryAt))) return false

  log.warn(
    {
      event: 'task.retry_scheduled',
      taskId: execution.taskId,
      attempt: attemptJustFailed,
      nextAttempt: attemptJustFailed + 1,
      delayMs: plan.delayMs,
      err: errSummary,
    },
    'task transient failure, scheduling retry',
  )
  return true
}

export async function runTask(id: string): Promise<void> {
  // 认领带 status='queued' 与 next_retry_at 已到两道守卫，避免 scheduler 或外部误调
  // runTask 让等待中的重试任务提前起跑。
  const execution = await claimTaskExecution(id)
  if (!execution) return
  try {
    await executeTask(execution)
  } catch (error) {
    await execution.finish({
      status: 'failed',
      errorType: 'interrupted',
      errorMessage: '任务执行异常',
      preserveArchive: true,
      completedAt: Date.now(),
    })
    throw error
  } finally {
    execution.release()
  }
}

async function executeTask(execution: TaskExecution): Promise<void> {
  const now = () => Date.now()
  const { taskId: id, task, claimedAt, signal } = execution
  let request = task.request_payload

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
    task.user_id && !request.video && isCapabilityEnabled('accounts:sync'),
  )
  let archivePayload = task.archive_payload
  let receivedImages = false
  let protectOutput: Awaited<ReturnType<typeof protectMaskedOutput>> | undefined
  const stopExpiredArchive = async (cause?: unknown): Promise<boolean> => {
    if (!archivePayload) return false
    const startedAt = task.archive_retry_started_at ?? claimedAt
    if (now() - startedAt < ARCHIVE_RETRY_BUDGET_MS) return false
    const failed = await execution.finish({
      status: 'failed',
      errorType: 'object_storage_error',
      errorMessage: '图片已生成，但保存结果连续失败超过 1 小时，已停止自动重试。请联系支持。',
      preserveArchive: true,
      completedAt: now(),
    })
    if (failed)
      log.error(
        { event: 'task.archive_retry_exhausted', taskId: id, startedAt, err: String(cause) },
        'generated output archive exceeded retry budget',
      )
    return true
  }
  try {
    if (await stopExpiredArchive()) return
    if (cloudArchive && !archivePayload) {
      const preserved = await execution.preserveInputs(request)
      if (!preserved) return
      request = preserved
    }
    const hydratedRequest = await hydrateInputImages(request)
    // 老任务只有 preserve_outside_mask、没有 masked_original_size：那时不补边，交付时也不裁边。
    protectOutput = request.preserve_outside_mask
      ? await protectMaskedOutput(
          hydratedRequest.input_images?.[0] ?? '',
          hydratedRequest.mask ?? '',
          request.masked_original_size,
        )
      : undefined
    if (archivePayload) {
      archivePayload = await spoolGenerationOutputs(
        id,
        task.provider,
        archivePayload,
        protectOutput,
        signal,
      )
      if (!(await execution.saveCheckpoint(archivePayload))) return
      const missing = await missingGenerationOutputs(id, task.provider, archivePayload)
      const media = await archiveGenerationOutputs(
        task.user_id!,
        task.provider,
        archivePayload,
        request,
        missing,
      )
      await execution.finish({
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
      signal,
      resume,
      onUpstreamTaskIds: (taskIds) =>
        execution.recordUpstreamTaskIds(taskIds, resume !== undefined),
      beforeRequest: async () => {
        if (resume && task.upstream_invocation_count > resume.taskIds.length) {
          throw new UpstreamResultUnknownError('上次提交的部分结果未知，未重复生成')
        }
        if (await execution.recordUpstreamInvocation()) return
        // 记不上账就是这一行不归我了：扇出的其余请求一并停掉。
        execution.abort()
        throw new DOMException('Task is no longer running', 'AbortError')
      },
    }
    const { payload } = await callUpstream(upstreamCall).catch(async (error) => {
      if (
        !(error instanceof UpstreamTimeoutError) ||
        (resume && resume.submittedAt <= claimedAt - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)
      )
        throw error
      const persisted = await execution.readUpstreamSubmission()
      if (!persisted) throw error
      return callUpstream({
        ...upstreamCall,
        resume: { ...persisted, pollOnly: true },
      })
    })
    const meta = extractMeta(task.provider, payload)
    if (meta.images.length === 0) {
      const message = describeEmptyResult(task.provider, payload)
      const attemptJustFailed = task.attempt_count + 1
      // 审核拒绝与「上游抽风没出图」的出路不同：前者要改提示词，后者再跑一次就好。
      const blocked = isContentPolicyEmptyResult(task.provider, payload)
      // 遮罩提交一律不自动重生成：失败就是终态，要不要再来一次由那一轮的智能体决定。
      if (
        !request.preserve_outside_mask &&
        (await tryScheduleRetry(
          execution,
          attemptJustFailed,
          !blocked && shouldRetryEmptyResult(task.provider, payload),
          `no_image: ${message}`,
        ))
      ) {
        return
      }
      await execution.finish({
        status: 'failed',
        errorMessage: message,
        errorType: blocked ? 'content_policy' : 'upstream_no_image',
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
          if (!(await execution.saveCheckpoint(archivePayload))) return
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
      ? await spoolGenerationOutputs(id, task.provider, payload, protectOutput, signal)
      : await archiveOutputImages(id, task.provider, payload, protectOutput)
    if (cloudArchive) {
      archivePayload = archivedPayload
      if (!(await execution.saveCheckpoint(archivePayload))) return
    }
    const media = cloudArchive
      ? await archiveGenerationOutputs(task.user_id!, task.provider, archivedPayload, request)
      : undefined
    await execution.finish({
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
    // 下面的写入因句柄的 fence 与 status 守卫自然 no-op。
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
      if (await stopExpiredArchive(err)) return
      await execution.requeueArchive(Date.now() + 60_000, archivePayload)
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
    const upstreamFailure = extractUpstreamFailure(err)
    const errorType: TaskErrorType = isStorageError
      ? 'object_storage_error'
      : isUnknownResult
        ? 'upstream_result_unknown'
        : isContentPolicyRejection({
              status: upstreamFailure.status,
              message,
              payload: upstreamFailure.body,
            })
          ? 'content_policy'
          : 'upstream_error'

    const attemptJustFailed = task.attempt_count + 1
    if (
      !request.preserve_outside_mask &&
      (await tryScheduleRetry(
        execution,
        attemptJustFailed,
        !(cloudArchive && receivedImages) && isRetryableError(err),
        message,
      ))
    ) {
      return
    }

    const failed = await execution.finish({
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
      upstreamStatus: upstreamFailure.status,
      upstreamBody: upstreamFailure.body,
      completedAt: now(),
    })
    if (failed) {
      log.error(
        {
          event: 'task.failed',
          taskId: id,
          errorType,
          attempt: attemptJustFailed,
          upstreamStatus: upstreamFailure.status,
          err: message,
        },
        'task failed',
      )
    }
  }
}
