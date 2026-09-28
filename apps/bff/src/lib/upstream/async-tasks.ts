import { log } from '../logger'
import { isObject } from '../type-guards'
import { extractErrorMessage, extractUpstreamFailure, UpstreamResultUnknownError } from './errors'

/**
 * 轮询专用的可恢复判定，**与 retry.ts 的提交侧判定方向相反**，不要合并：提交没有幂等键，
 * 重来一次就是重复计费；轮询只是再读一次同一个任务，代价为零。
 */
export function isRecoverablePollFailure(err: unknown): boolean {
  const { status } = extractUpstreamFailure(err)
  if (status === null) return err instanceof UpstreamResultUnknownError
  return status === 408 || status === 429 || status >= 500
}

/**
 * 一种上游异步任务形态：提交地址、id 字段、轮询地址、状态词表。
 * 图片与两家视频上游共用同一套提交 / 落库 / 轮询骨架，差异全在这四项。
 */
export interface AsyncTaskProtocol {
  readonly submitUrl: string
  readonly pollUrl: (taskId: string) => string
  readonly readTaskId: (payload: unknown) => string
  readonly readState: (payload: unknown) => AsyncTaskState
}

export function imageTaskProtocol(base: string, submitBase: string): AsyncTaskProtocol {
  return {
    submitUrl: `${submitBase}/async`,
    pollUrl: (taskId) => `${base}/images/tasks/${encodeURIComponent(taskId)}`,
    readTaskId: (payload) => readTaskIdField(payload, ['task_id']),
    readState: readAsyncTaskState,
  }
}

export function readTaskIdField(payload: unknown, fields: readonly string[]): string {
  const body = (payload ?? {}) as Record<string, unknown>
  for (const field of fields) {
    const value = body[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  // 任务可能已经建起来在烧钱，但我们拿不到 id 去轮询它 —— 按结果未知处理，绝不自动重提。
  throw new UpstreamResultUnknownError(`上游异步任务提交未返回 ${fields[0]}，执行结果未知`)
}

/** 上游把异步开关关掉时提交一律 404。单独一条 event，别混在通用 upstream 失败里。 */
export function warnIfAsyncTasksDisabled(err: unknown): void {
  const { status, body } = extractUpstreamFailure(err)
  if (status !== 404 || !body?.includes('async image tasks are not enabled')) return
  log.error(
    { event: 'upstream.async_disabled', upstreamStatus: status },
    'upstream async image tasks are disabled; turn off the asyncTasks declaration on our side',
  )
}

export type AsyncTaskState =
  | { kind: 'pending' }
  | { kind: 'completed'; payload: unknown }
  | { kind: 'failed'; status: number | null }

/** 未知 status 一律当 pending 继续轮：上游加新中间态时不该把任务判死。 */
function readAsyncTaskState(payload: unknown): AsyncTaskState {
  if (!payload || typeof payload !== 'object') return { kind: 'pending' }
  const body = payload as { status?: unknown; result?: unknown; http_status?: unknown }
  if (body.status === 'completed') {
    // 结果在 result 里；上游也可能直接把 OpenAI envelope 平铺在根级。
    const result = body.result
    return { kind: 'completed', payload: result && typeof result === 'object' ? result : payload }
  }
  if (body.status !== 'failed') return { kind: 'pending' }
  return { kind: 'failed', status: typeof body.http_status === 'number' ? body.http_status : null }
}

function readStatusToken(payload: unknown): string | null {
  const status = (payload as { status?: unknown } | null)?.status
  return typeof status === 'string' ? status.toLowerCase() : null
}

/** 未知 status 一律当 pending 继续轮：上游加新中间态时不该把任务判死。 */
export function videoStatusReader(
  done: readonly string[],
  failed: readonly string[],
): (payload: unknown) => AsyncTaskState {
  const doneStatuses = new Set(done)
  const failedStatuses = new Set(failed)
  return (payload) => {
    const status = readStatusToken(payload)
    if (status === null) return { kind: 'pending' }
    if (doneStatuses.has(status)) return { kind: 'completed', payload }
    if (failedStatuses.has(status)) return { kind: 'failed', status: null }
    return { kind: 'pending' }
  }
}

/** 已知错误码换成中文文案；上游英文原文仍完整落 upstream_body。 */
function asyncFailureMessage(payload: unknown, status: number | null): string {
  const error = isObject(payload) ? payload.error : null
  if (isObject(error) && error.code === 'internal_error') return '上游服务异常，请稍后重试'
  return extractErrorMessage(payload, status ?? 502)
}

/** 上游任务终态失败 → 复用 HTTP 失败的错误形状，retry.ts 与 admin 才认得出来。 */
export function asyncTaskFailure(status: number | null, payload: unknown): Error {
  const err = new Error(asyncFailureMessage(payload, status)) as Error & {
    upstreamStatus?: number
    upstreamPayload: unknown
  }
  if (status !== null) err.upstreamStatus = status
  err.upstreamPayload = payload
  return err
}
