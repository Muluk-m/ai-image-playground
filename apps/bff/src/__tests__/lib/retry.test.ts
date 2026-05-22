import { describe, expect, it } from 'bun:test'
import { isRetryableError, MAX_ATTEMPTS, planNextAttempt, RETRY_BACKOFF_MS } from '../../lib/retry'

function upstreamError(status: number): Error {
  const err = new Error(`upstream ${status}`) as Error & { upstreamStatus: number }
  err.upstreamStatus = status
  return err
}

// 故意不 import lib/upstream（避免 import lib/upstream → config 触发 env 读取，
// 污染同进程后续 routes.test.ts 的 DATABASE_URL 覆写时机）。用 name 模拟。
function fakeUpstreamTimeoutError(): Error {
  const err = new Error('upstream timeout')
  err.name = 'UpstreamTimeoutError'
  return err
}

describe('isRetryableError', () => {
  it('上游 5xx 视为瞬时，需要重试', () => {
    expect(isRetryableError(upstreamError(500))).toBe(true)
    expect(isRetryableError(upstreamError(502))).toBe(true)
    expect(isRetryableError(upstreamError(503))).toBe(true)
    expect(isRetryableError(upstreamError(504))).toBe(true)
  })

  it('429 限流重试，其它 4xx 不重试', () => {
    expect(isRetryableError(upstreamError(429))).toBe(true)
    expect(isRetryableError(upstreamError(408))).toBe(true) // request timeout
    expect(isRetryableError(upstreamError(400))).toBe(false)
    expect(isRetryableError(upstreamError(401))).toBe(false)
    expect(isRetryableError(upstreamError(403))).toBe(false)
    expect(isRetryableError(upstreamError(404))).toBe(false)
    expect(isRetryableError(upstreamError(422))).toBe(false)
  })

  it('BFF 自家硬超时 UpstreamTimeoutError 重试', () => {
    expect(isRetryableError(fakeUpstreamTimeoutError())).toBe(true)
  })

  it('未带 upstreamStatus 的 Error（fetch 抛错 / 网络中断）重试', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('非 Error 类型（字符串 / null / undefined）不重试，防御性', () => {
    expect(isRetryableError('something')).toBe(false)
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
    expect(isRetryableError({ random: true })).toBe(false)
  })
})

describe('planNextAttempt', () => {
  it('刚失败 1 次：第 2 次按 BACKOFF[0]', () => {
    const plan = planNextAttempt(1, 1_000_000)
    if (!plan.shouldRetry) throw new Error('expected shouldRetry=true')
    expect(plan.delayMs).toBe(RETRY_BACKOFF_MS[0] ?? -1)
    expect(plan.nextRetryAt).toBe(1_000_000 + (RETRY_BACKOFF_MS[0] ?? 0))
  })

  it('刚失败 2 次：第 3 次按 BACKOFF[1]', () => {
    const plan = planNextAttempt(2, 2_000_000)
    if (!plan.shouldRetry) throw new Error('expected shouldRetry=true')
    expect(plan.delayMs).toBe(RETRY_BACKOFF_MS[1] ?? -1)
    expect(plan.nextRetryAt).toBe(2_000_000 + (RETRY_BACKOFF_MS[1] ?? 0))
  })

  it('达到 MAX_ATTEMPTS 后不再重试', () => {
    expect(planNextAttempt(MAX_ATTEMPTS, 1_000_000).shouldRetry).toBe(false)
  })

  it('attemptJustFailed 超过 MAX_ATTEMPTS 也不重试（防御性）', () => {
    expect(planNextAttempt(MAX_ATTEMPTS + 5, 1_000_000).shouldRetry).toBe(false)
  })
})
