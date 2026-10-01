import { isObject } from '../type-guards'

/**
 * 自定义错误：BFF 自己的 UPSTREAM_HARD_TIMEOUT_MS 切的（vs 上游返 4xx/5xx
 * 或 socket 异常关）。task-runner 用 instanceof 检查并统一落库为
 * `upstream_result_unknown`，避免自动重试重复执行。
 */
export class UpstreamResultUnknownError extends Error {
  readonly retryable = false
  readonly upstreamStatus: number | undefined
  readonly upstreamPayload: unknown
  readonly requiresReconciliation: boolean

  constructor(message: string, options?: ErrorOptions & { requiresReconciliation?: boolean }) {
    super(message, options)
    this.name = 'UpstreamResultUnknownError'
    const cause = isObject(options?.cause) ? options.cause : undefined
    this.upstreamStatus =
      typeof cause?.upstreamStatus === 'number' ? cause.upstreamStatus : undefined
    this.upstreamPayload = cause?.upstreamPayload
    this.requiresReconciliation = options?.requiresReconciliation ?? false
  }
}

export class UpstreamPartialResultError extends UpstreamResultUnknownError {
  constructor(readonly payload: unknown) {
    super('部分图片已完成，其余提交结果未知；未重复生成')
  }
}

export class UpstreamTimeoutError extends UpstreamResultUnknownError {
  constructor(message = 'Upstream call exceeded BFF hard timeout') {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
}

/**
 * 非 2xx 时上游响应体的截断上限，避免上游回 base64 巨长串吞内存。log preview 与
 * 落库的 tasks.upstream_body 共用同一上限，两处看到的内容一致。
 */
const UPSTREAM_ERROR_BODY_MAX_CHARS = 2000

/** 上游错误响应体转可存储字符串（截断）。空体返回 null，避免落库一个空串。 */
export function stringifyUpstreamPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null
  const text = typeof payload === 'object' ? JSON.stringify(payload) : String(payload)
  if (!text) return null
  return text.slice(0, UPSTREAM_ERROR_BODY_MAX_CHARS)
}

/**
 * 从 catch 到的错误里抽上游诊断信息，供 task-runner 落库、admin 直接展示。
 * 两个字段互相独立：异步任务终态失败有 body 没有 HTTP status，别再把 body 挂到 status 上。
 */
export function extractUpstreamFailure(err: unknown): {
  status: number | null
  body: string | null
} {
  if (!isObject(err)) return { status: null, body: null }
  const status = err.upstreamStatus
  return {
    status: typeof status === 'number' ? status : null,
    body: stringifyUpstreamPayload(err.upstreamPayload),
  }
}

export function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const errObj = obj.error as { message?: string } | string | undefined
    if (typeof errObj === 'object' && typeof errObj?.message === 'string') return errObj.message
    if (typeof errObj === 'string') return errObj
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.detail === 'string') return obj.detail
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.length > 500 ? `${payload.slice(0, 500)}…` : payload
  }
  return `Upstream HTTP ${status}`
}
