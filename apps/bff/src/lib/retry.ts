/**
 * 自动重试策略：上游 5xx / 429 / 网络异常 / BFF 自家硬超时算「瞬时」，重试。
 * 其它 4xx / no_image（内容策略）/ 用户 cancel 一律永久失败，避免空转烧配额。
 *
 * **不重试**：
 * - HTTP 4xx 除 429（参数错 / 鉴权 / 内容策略 → 重试结果一致）
 * - upstream_no_image（Gemini 安全过滤会稳定复现；OpenAI 异常 envelope 罕见）
 * - AbortError（用户主动取消 / SIGTERM）
 *
 * 故意不 import lib/upstream：retry 是纯策略层，避免触发 upstream.ts → config.ts
 * 的副作用链（config 模块顶层读 env，会污染 test 文件间的 env override 时机）。
 * 用 name 标记 duck-typing 判 UpstreamTimeoutError。
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
  // duck-type 判 UpstreamTimeoutError：upstream.ts 给该 Error 的 name 打了固定标签，
  // 这里走名字判断而不 import lib/upstream，避免 config 模块副作用污染测试 env 时机。
  if (err.name === 'UpstreamTimeoutError') return true
  const status = (err as { upstreamStatus?: unknown }).upstreamStatus
  if (typeof status === 'number') return RETRYABLE_HTTP_STATUSES.has(status)
  // 没带 upstreamStatus 的多是 fetch 自身抛错（网络中断、socket reset、DNS 失败），重试。
  return true
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
