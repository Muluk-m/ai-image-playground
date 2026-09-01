import { describe, expect, it } from 'bun:test'
import {
  isRetryableError,
  MAX_ATTEMPTS,
  planNextAttempt,
  RETRY_BACKOFF_MS,
  shouldRetryEmptyResult,
} from '../../lib/retry'

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

  it('BFF 自家硬超时结果未知，不自动重试', () => {
    expect(isRetryableError(fakeUpstreamTimeoutError())).toBe(false)
  })

  it('未带 upstreamStatus 的 Error（fetch 抛错 / 网络中断）结果未知，不自动重试', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(false)
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('带 retryable 标记的错误直接重试（归档回源取图失败）', () => {
    const err = new Error('transient step failure') as Error & { retryable: boolean }
    err.retryable = true
    expect(isRetryableError(err)).toBe(true)
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

describe('shouldRetryEmptyResult (Gemini)', () => {
  const make = (finishReason?: string, blockReason?: string) => ({
    candidates: finishReason ? [{ finishReason }] : [],
    ...(blockReason ? { promptFeedback: { blockReason } } : {}),
  })

  it('finishReason=STOP（模型自然停止没出图）重试', () => {
    expect(shouldRetryEmptyResult('gemini', make('STOP'))).toBe(true)
  })

  it('finishReason=MAX_TOKENS 重试', () => {
    expect(shouldRetryEmptyResult('gemini', make('MAX_TOKENS'))).toBe(true)
  })

  it('SAFETY / IMAGE_SAFETY / RECITATION / PROHIBITED_CONTENT / BLOCKLIST / SPII 不重试', () => {
    for (const reason of [
      'SAFETY',
      'IMAGE_SAFETY',
      'RECITATION',
      'PROHIBITED_CONTENT',
      'BLOCKLIST',
      'SPII',
    ]) {
      expect(shouldRetryEmptyResult('gemini', make(reason))).toBe(false)
    }
  })

  it('promptFeedback.blockReason 命中即不重试（prompt 整体被拦）', () => {
    expect(shouldRetryEmptyResult('gemini', make(undefined, 'SAFETY'))).toBe(false)
  })

  it('无 finishReason / 无 candidates 视为抽风，重试', () => {
    expect(shouldRetryEmptyResult('gemini', {})).toBe(true)
    expect(shouldRetryEmptyResult('gemini', null)).toBe(true)
    expect(shouldRetryEmptyResult('gemini', { candidates: [] })).toBe(true)
  })
})

describe('shouldRetryEmptyResult (OpenAI)', () => {
  it('OpenAI no_image 默认重试（200 OK 但没图通常是异常 envelope）', () => {
    expect(shouldRetryEmptyResult('openai-compat', {})).toBe(true)
    expect(shouldRetryEmptyResult('openai-compat', { data: [] })).toBe(true)
  })
})
