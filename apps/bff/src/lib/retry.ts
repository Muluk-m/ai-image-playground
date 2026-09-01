import type { QueueProvider } from '@image-playground/shared'

/**
 * 自动重试策略：只重试上游明确返回的 408 / 429 / 5xx、「200 OK 但没图」，以及归档阶段
 * 回源拉结果 URL 失败这三类瞬时分支。
 * 网络中断 / socket reset / BFF 硬超时都可能发生在上游已开始执行之后，结果未知，
 * 自动重试会重复生图和扣配额，因此一律不重试。
 * 4xx / 内容审核类 finishReason / 用户 cancel 一律永久失败，避免空转烧配额。
 *
 * **不重试**：
 * - HTTP 4xx 除 429（参数错 / 鉴权 / 内容策略 → 重试结果一致）
 * - transport error / UpstreamTimeoutError（上游执行结果未知）
 * - AbortError（用户主动取消 / SIGTERM）
 * - Gemini no_image 且 finishReason ∈ {SAFETY, IMAGE_SAFETY, RECITATION, ...}（审核显式拒绝）
 *
 * 故意不 import lib/upstream / lib/imageArchive：retry 是纯策略层，避免触发
 * upstream.ts → config.ts 的副作用链（config 模块顶层读 env，会污染 test 文件间的
 * env override 时机）。错误类型一律按结构字段识别，不用 instanceof。
 * 既无 upstreamStatus 也无 retryable 标记的错误都保守视为不可重试。
 */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/** 失败到第 N 次的退避：第 1 次失败后等 10s 跑 attempt#2，第 2 次失败等 30s 跑 attempt#3。 */
export const RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000, 60_000]

/** 总尝试次数（含首次）上限。MAX_ATTEMPTS=3 ⇒ 最多重试 2 次。 */
export const MAX_ATTEMPTS = 3

/**
 * 判断 task-runner catch 到的错误是否值得自动重试。**不含**用户 cancel：
 * task-runner 在 catch 顶部用 isAbortError 单独 early-return。
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ((err as { retryable?: unknown }).retryable === true) return true
  const status = (err as { upstreamStatus?: unknown }).upstreamStatus
  if (typeof status === 'number') return RETRYABLE_HTTP_STATUSES.has(status)
  return false
}

export type RetryPlan =
  | { shouldRetry: false }
  | { shouldRetry: true; nextRetryAt: number; delayMs: number }

/**
 * 给定「刚失败的尝试次数 attemptJustFailed」（=失败前已记录的 attempt_count+1），
 * 返回这次失败后是否还该重试 + 下次发起时间戳。BACKOFF_MS[N-1] 对应「失败 N 次后
 * 等多久跑第 N+1 次」。
 */
export function planNextAttempt(attemptJustFailed: number, now: number = Date.now()): RetryPlan {
  if (attemptJustFailed >= MAX_ATTEMPTS) return { shouldRetry: false }
  const delayMs = RETRY_BACKOFF_MS[attemptJustFailed - 1] ?? RETRY_BACKOFF_MS.at(-1) ?? 60_000
  return { shouldRetry: true, nextRetryAt: now + delayMs, delayMs }
}

/**
 * Gemini finishReason 黑名单：这些都是显式审核 / 策略拒绝，重试结果稳定复现。
 * 不在此集合内的 reason（含 STOP / MAX_TOKENS / 不明 / 未携带）视为模型抽风，
 * 走重试——实测 Gemini 即便 finishReason=STOP 也常常二次请求就能出图。
 */
const NON_RETRYABLE_GEMINI_FINISH = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
])

/**
 * 「上游 HTTP 200 但解析不出图」是否值得重试。task-runner 拿不到 Error 对象，
 * 只能由 payload 上的 finishReason / blockReason 决定——审核显式拒绝不重试。
 */
export function shouldRetryEmptyResult(provider: QueueProvider, payload: unknown): boolean {
  if (provider === 'gemini') {
    const p = payload as {
      candidates?: Array<{ finishReason?: string }>
      promptFeedback?: { blockReason?: string }
    } | null
    // prompt 整体被拦：肯定是审核类，永久失败。
    if (p?.promptFeedback?.blockReason) return false
    const reason = p?.candidates?.[0]?.finishReason
    if (typeof reason === 'string' && NON_RETRYABLE_GEMINI_FINISH.has(reason)) return false
    return true
  }
  // OpenAI 200 OK no_image 罕见，通常是上游异常 envelope。视为瞬时重试。
  if (provider === 'openai-compat') return true
  return false
}
