import { setTimeout as delay } from 'node:timers/promises'
import type { TaskErrorType, TaskStatus } from '@image-playground/shared'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { describeEmptyResult, type ExtractedResult, extractMeta } from '../../lib/extractImages'
import { publicTaskErrorMessage } from '../../lib/public-task-error'
import { asQueueProvider } from '../../lib/queueProvider'

/** 队列任务的终态。`extractMeta` 的结果只在 completed 时有意义。 */
export type QueueTaskOutcome =
  | { readonly kind: 'completed'; readonly result: ExtractedResult }
  | {
      readonly kind: 'failed'
      readonly reason: string
      /** worker 记下的失败类型；等超时记 `upstream_timeout`，完成却没图记 `upstream_no_image`。 */
      readonly errorType: TaskErrorType | null
      /** 任务被取消（轮中止、会话删除），不是上游失败。 */
      readonly cancelled?: true
      /** 等待预算用完时任务还没到终态：它可能仍在跑、仍会出图计费，由调用方决定怎么收场。 */
      readonly stillRunning?: true
    }

/** 读一条队列任务的终局要用到的那几列。 */
export interface QueueTaskTerminalRow {
  readonly status: TaskStatus
  readonly provider: string
  readonly result_payload: unknown
  readonly error_message: string | null
  readonly error_type: string | null
}

/** 任务行此刻的终局；还没到终态就是 null。等结果与后台任务结算读的是同一个算式。 */
export function queueTaskOutcome(task: QueueTaskTerminalRow): QueueTaskOutcome | null {
  if (task.status === 'failed') {
    return {
      kind: 'failed',
      reason: publicTaskErrorMessage(task.error_message ?? '任务失败'),
      // 列是自由文本；写它的只有 worker，值域就是 `TaskErrorType`。
      errorType: (task.error_type as TaskErrorType | null) ?? null,
    }
  }
  if (task.status === 'cancelled')
    return { kind: 'failed', reason: '任务被取消了', errorType: null, cancelled: true }
  if (task.status === 'completed') {
    const provider = asQueueProvider(task.provider)
    if (!provider)
      return { kind: 'failed', reason: `未知的上游：${task.provider}`, errorType: 'unknown' }
    const result = extractMeta(provider, task.result_payload)
    if (result.images.length === 0) {
      return {
        kind: 'failed',
        reason: describeEmptyResult(provider, task.result_payload),
        errorType: 'upstream_no_image',
      }
    }
    return { kind: 'completed', result }
  }
  return null
}

interface Polling {
  readonly intervalMs: number
  readonly budgetMs: number
}

const DEFAULT_POLLING: Polling = { intervalMs: 1_000, budgetMs: QUEUE_TIMEOUTS.POLL_MAX_MS }

let polling = DEFAULT_POLLING

/** 测试注入点；不传恢复真实节奏。 */
export function setQueueTaskPollingForTesting(next?: Partial<Polling>): void {
  polling = next ? { ...DEFAULT_POLLING, ...next } : DEFAULT_POLLING
}

/** 越等越慢：任务刚提交那几秒 worker 还没轮到它，密集查只是空转。 */
function nextInterval(waitedMs: number): number {
  const step = waitedMs < 5_000 ? 1 : waitedMs < 20_000 ? 2 : 5
  return polling.intervalMs * step
}

/**
 * 等一条队列任务跑到终态。进程内轮询任务表，与 worker 的调度轮询各管各的。
 * `onStatus` 每次状态变化报一次，供调用方把进度推给用户。
 */
export async function awaitQueueTask(
  taskId: string,
  options: {
    readonly signal?: AbortSignal
    readonly onStatus?: (status: TaskStatus) => void
  } = {},
): Promise<QueueTaskOutcome> {
  const startedAt = Date.now()
  let announced: TaskStatus | undefined
  while (true) {
    if (options.signal?.aborted) throw new Error('这一轮被中止了')
    const [task] = await db
      .select({
        status: schema.tasks.status,
        provider: schema.tasks.provider,
        result_payload: schema.tasks.result_payload,
        error_message: schema.tasks.error_message,
        error_type: schema.tasks.error_type,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    if (!task) return { kind: 'failed', reason: '任务丢失了', errorType: 'unknown' }

    if (task.status !== announced) {
      announced = task.status
      options.onStatus?.(task.status)
    }
    const settled = queueTaskOutcome(task)
    if (settled) return settled

    const waited = Date.now() - startedAt
    if (waited > polling.budgetMs)
      return {
        kind: 'failed',
        reason: '超时未返回',
        errorType: 'upstream_timeout',
        stillRunning: true,
      }
    await delay(nextInterval(waited), undefined, { signal: options.signal })
  }
}
