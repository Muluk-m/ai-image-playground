import { QUEUE_TIMEOUTS, type QueueProvider } from '@image-playground/shared'
import type { Span } from '@opentelemetry/api'
import { log } from '../logger'
import { ImageResponsesError, readImageResponses } from '../openaiImageResponses'
import { recordSpanError, SpanKind, SpanStatusCode, tracer, withTraceHeaders } from '../telemetry'
import { createDispatcher, createFetchSlot, startDeadline } from '../timeoutFetch'
import { parseUpstreamResponse } from './bounded-error'
import {
  ImagePlanRequiredError,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './errors'
import {
  requiresGptDirect,
  resolveUpstream,
  type UpstreamRoute,
  upstreamAuthHeader,
} from './routes'
import { type SchedulerLease, tryAcquireSchedulerSlots, waitForSchedulerSlots } from './scheduler'
import type { UpstreamCallResult } from './shared'
import type {
  AttemptOptions,
  UpstreamCallParams,
  UpstreamCancelOutcome,
  UpstreamFetch,
  UpstreamFetchInit,
  UpstreamResponse,
} from './types'
import { VIDEO_STYLE_SPECS } from './video'

export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000

export const UPSTREAM_TRANSPORT_TIMEOUT_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60_000

const UPSTREAM_CANCEL_TIMEOUT_MS = 10_000

const upstreamDispatcher = createDispatcher({
  connectMs: UPSTREAM_CONNECT_TIMEOUT_MS,
  transportMs: UPSTREAM_TRANSPORT_TIMEOUT_MS,
})

const upstreamTransport = createFetchSlot<UpstreamFetch>()

/** span 只记主机名：完整地址的查询串里可能带 key（Gemini 的 `?key=`）。 */
function upstreamHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

export function setUpstreamFetchForTesting(fetchImpl?: UpstreamFetch): void {
  upstreamTransport.set(fetchImpl)
}

/** 轮询退避（ms），index 超出取末位。上游 202 响应的 `Retry-After` 也是 3。 */
const ASYNC_POLL_BACKOFF_MS: readonly number[] = [3_000, 3_000, 5_000, 5_000, 10_000]

let asyncPollBackoffMs = ASYNC_POLL_BACKOFF_MS

/** 测试注入点；undefined 恢复真实退避（否则一次重试就要真睡 3 秒）。 */
export function setAsyncPollBackoffForTesting(backoffMs?: readonly number[]): void {
  asyncPollBackoffMs = backoffMs ?? ASYNC_POLL_BACKOFF_MS
}

export function asyncPollDelayMs(attempt: number): number {
  return asyncPollBackoffMs[Math.min(attempt, asyncPollBackoffMs.length - 1)]!
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upstream polling aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface UpstreamTransportSession {
  readonly deadlineAt: number
  readonly finalLookup: boolean
  readonly deadline: ReturnType<typeof startDeadline>
  readonly externalSignal: AbortSignal | undefined
  cancelled(): boolean
  queueTimeoutError(): UpstreamQueueTimeoutError
  setImagesPerDispatch(count: number): void
  dispatchIdentityOf(res: UpstreamResponse): string | undefined
  performFetch(
    url: string,
    init: UpstreamFetchInit,
    counted?: boolean,
    requestModel?: string,
  ): Promise<UpstreamResponse>
  parseResponse(res: UpstreamResponse, imageResponses?: boolean): Promise<UpstreamCallResult>
  abort(): void
  cleanup(): Promise<void>
}

export function createUpstreamSession(
  params: UpstreamCallParams,
  route: UpstreamRoute,
  attempt: AttemptOptions,
  initialImagesPerDispatch: number,
): UpstreamTransportSession {
  const { provider, model, signal: callerSignal, beforeRequest, resume } = params
  const externalSignal =
    attempt.signal && callerSignal
      ? AbortSignal.any([callerSignal, attempt.signal])
      : (attempt.signal ?? callerSignal)
  const { style, schedulerBuckets = [] } = route

  const deadlineAt =
    attempt.deadlineAt ??
    (resume?.submittedAt ?? Date.now()) + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS
  // A resumed task may have completed while its worker was unavailable. Give the
  // read-only final lookup a bounded transport window, never a new generation budget.
  const finalLookup = Boolean(resume?.taskIds.length) && Date.now() >= deadlineAt
  const deadline = startDeadline(finalLookup ? 20_000 : deadlineAt - Date.now(), externalSignal)
  /** 调用方叫停了（用户取消、租约丢了）：fan-out 的部分结果不交付，照原样抛。 */
  const cancelled = () => externalSignal?.aborted === true

  const fetchInit = (init: UpstreamFetchInit): UpstreamFetchInit => ({
    ...init,
    signal: deadline.signal,
    dispatcher: upstreamDispatcher,
  })

  const dispatchIdentities = new WeakMap<UpstreamResponse, string>()
  const dispatchTimings = new WeakMap<
    UpstreamResponse,
    { sentAt: number; headersMs: number; model: string; span: Span }
  >()

  const logRequestFinished = (fields: {
    outcome: 'ok' | 'http_error' | 'read_error' | 'transport_error' | 'aborted'
    status: number | null
    headersMs: number | null
    sentAt: number
    model: string
    span: Span
    error?: unknown
  }) => {
    const { span } = fields
    if (fields.status !== null) span.setAttribute('http.response.status_code', fields.status)
    if (fields.headersMs !== null) span.setAttribute('upstream.headers_ms', fields.headersMs)
    span.setAttribute('upstream.outcome', fields.outcome)
    if (fields.outcome === 'aborted') {
      // 取消是预期内的结束，不标错误，也不记异常。
    } else if (fields.error !== undefined) recordSpanError(span, fields.error)
    else if (fields.outcome !== 'ok') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
    log.info(
      {
        event: 'upstream.request_finished',
        ...(params.taskId ? { taskId: params.taskId } : {}),
        provider,
        model: fields.model,
        style,
        outcome: fields.outcome,
        status: fields.status,
        headersMs: fields.headersMs,
        totalMs: Math.round(performance.now() - fields.sentAt),
      },
      'upstream request finished',
    )
  }

  const queueTimeoutError = () => new UpstreamQueueTimeoutError()
  let imagesPerDispatch = initialImagesPerDispatch
  const schedulerLeases = new WeakMap<UpstreamResponse, SchedulerLease>()
  const outstandingLeases = new Set<SchedulerLease>()
  const releaseLease = async (lease: SchedulerLease, refund = false) => {
    outstandingLeases.delete(lease)
    await lease.release({ refund })
  }

  const performFetch = async (
    url: string,
    init: UpstreamFetchInit,
    counted = true,
    requestModel = model,
  ): Promise<UpstreamResponse> => {
    let lease: SchedulerLease | undefined
    if (counted && schedulerBuckets.length > 0) {
      try {
        if (requiresGptDirect(params)) {
          lease = (await tryAcquireSchedulerSlots(schedulerBuckets, imagesPerDispatch)) ?? undefined
          if (!lease) throw new ImagePlanRequiredError()
        } else {
          lease = await waitForSchedulerSlots(schedulerBuckets, imagesPerDispatch, deadline.signal)
        }
      } catch (err) {
        // 排队时就超时：这条请求没发出去，确定未执行，不是「结果未知」。
        if (deadline.timedOut) throw queueTimeoutError()
        throw err
      }
      if (lease) outstandingLeases.add(lease)
    }
    let sent = false
    let sentAt: number | undefined
    let span: Span | undefined
    let headersAt: number | undefined
    // 记账回调开始前都确定没发出；回调里失败时不知道它是否已提交，按原样当「结果未知」。
    let committing = false
    try {
      if (deadline.signal.aborted) throw new DOMException('Upstream request aborted', 'AbortError')
      committing = true
      const dispatchId = counted ? await beforeRequest?.() : undefined
      sent = true
      const attributed = counted ? attempt.onDispatched?.() : undefined
      // The accounting callback is the dispatch commit point. Start the transport with a fresh
      // signal before relaying cancellation so a cancellation that loses the database race cannot
      // create a charged task without a corresponding upstream invocation.
      const requestAbort = new AbortController()
      const relayAbort = () => requestAbort.abort()
      if (counted) {
        sentAt = performance.now()
        const method = init?.method ?? 'GET'
        span = tracer.startSpan(`upstream ${method}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.request.method': method,
            'server.address': upstreamHost(url),
            'upstream.provider': provider,
            'upstream.model': requestModel,
            'upstream.style': style,
            ...(params.taskId ? { 'task.id': params.taskId } : {}),
          },
        })
      }
      const responsePromise = upstreamTransport.current(url, {
        ...fetchInit(init),
        ...(span
          ? {
              headers: withTraceHeaders(
                init?.headers,
                span,
              ) as NonNullable<UpstreamFetchInit>['headers'],
            }
          : {}),
        signal: requestAbort.signal,
      })
      // 首字节时刻挂在上游响应本身上，不被下面并行的记账写库拖长。
      if (sentAt !== undefined)
        void responsePromise.then(
          () => {
            headersAt = performance.now()
          },
          () => {},
        )
      deadline.signal.addEventListener('abort', relayAbort, { once: true })
      if (deadline.signal.aborted) relayAbort()
      let keyRecorded: Promise<void> | undefined
      try {
        if (counted && route.keyFingerprint) keyRecorded = params.onGptKey?.(route.keyFingerprint)
        const recorded = dispatchId ? params.onRequestDispatched?.(dispatchId) : undefined
        let response: UpstreamResponse
        try {
          ;[response] = await Promise.all([responsePromise, recorded, attributed, keyRecorded])
        } catch (error) {
          requestAbort.abort()
          // 旧通道的写入必须结束再允许换路，避免覆盖后续 sub2api 的清空结果。
          await Promise.allSettled([attributed, keyRecorded])
          throw error
        }
        if (dispatchId) dispatchIdentities.set(response, dispatchId)
        if (sentAt !== undefined && span)
          dispatchTimings.set(response, {
            sentAt,
            headersMs: Math.round((headersAt ?? performance.now()) - sentAt),
            model: requestModel,
            span,
          })
        if (lease) {
          schedulerLeases.set(response, lease)
          if (response.status === 429 && !route.skipSharedRateLimitCooldown)
            await lease.rateLimited()
        }
        const requestId =
          response.headers?.get('x-request-id') ?? response.headers?.get('request-id')
        if (dispatchId && requestId) await params.onRequestId?.(dispatchId, requestId)
        return response
      } finally {
        deadline.signal.removeEventListener('abort', relayAbort)
      }
    } catch (err) {
      if (sentAt !== undefined && span)
        logRequestFinished({
          outcome: externalSignal?.aborted && !deadline.timedOut ? 'aborted' : 'transport_error',
          status: null,
          headersMs: null,
          sentAt,
          model: requestModel,
          span,
          error: err,
        })
      // 记账回调之前就失败：这次没发出去，张数退回。
      if (lease) await releaseLease(lease, !sent)
      // 拿到名额时恰好到硬截止：还没进记账，同样是确定未执行。
      if (deadline.timedOut) throw committing ? new UpstreamTimeoutError() : queueTimeoutError()
      if (externalSignal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游连接中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  const parseResponse = async (
    res: UpstreamResponse,
    imageResponses = false,
  ): Promise<UpstreamCallResult> => {
    let read = false
    try {
      const result =
        imageResponses && res.ok
          ? { payload: await readImageResponses(res.body, deadline.signal) }
          : await parseUpstreamResponse(res)
      read = true
      attempt.onResponse?.()
      return result
    } catch (err) {
      // 上游回了错误状态码，body 也读完了：算 http_error，不是读取中断。
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') read = true
      if (deadline.timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      if (err instanceof ImageResponsesError) throw err
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游响应中断，执行结果未知：${detail}`, {
        cause: err,
      })
    } finally {
      const timing = dispatchTimings.get(res)
      if (timing)
        logRequestFinished({
          outcome: !read
            ? externalSignal?.aborted && !deadline.timedOut
              ? 'aborted'
              : 'read_error'
            : res.ok
              ? 'ok'
              : 'http_error',
          status: res.status,
          ...timing,
        })
      const lease = schedulerLeases.get(res)
      if (lease) await releaseLease(lease)
    }
  }

  return {
    deadlineAt,
    finalLookup,
    deadline,
    externalSignal,
    cancelled,
    queueTimeoutError,
    setImagesPerDispatch(count: number) {
      imagesPerDispatch = count
    },
    dispatchIdentityOf(res: UpstreamResponse) {
      return dispatchIdentities.get(res)
    },
    performFetch,
    parseResponse,
    abort() {
      deadline.abort()
    },
    async cleanup() {
      deadline.release()
      // 没走到 parseResponse 的响应（同批别的请求先失败等）也要还在途名额，不能等心跳过期。
      await Promise.all([...outstandingLeases].map((lease) => releaseLease(lease)))
    },
  }
}

/**
 * 用户取消任务后尽力叫停上游已经建起来的异步任务（BUG-32）。只对有取消接口的线路发请求，其余
 * 返回 null：同步线路靠断开连接收手，异步线路（sub2api、xAI、Veo）没有取消接口，只能停止轮询。
 * 失败只返回结果、从不抛出——退款早已在取消事务里落定，与这里无关。
 */
export async function cancelUpstreamTasks(
  provider: QueueProvider,
  model: string,
  taskIds: readonly string[],
): Promise<UpstreamCancelOutcome[] | null> {
  let route: UpstreamRoute
  try {
    route = resolveUpstream(provider, model)
  } catch {
    return null
  }
  const cancelUrl = VIDEO_STYLE_SPECS[route.style]?.cancelUrl
  if (!cancelUrl || taskIds.length === 0) return null
  const headers = upstreamAuthHeader(route.style, route.key)
  return Promise.all(
    taskIds.map(async (taskId): Promise<UpstreamCancelOutcome> => {
      try {
        const res = await upstreamTransport.current(cancelUrl(route.baseUrl, taskId), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(UPSTREAM_CANCEL_TIMEOUT_MS),
          dispatcher: upstreamDispatcher,
        })
        await (res.body ? res.body.cancel() : res.text()).catch(() => undefined)
        return res.ok
          ? { taskId, outcome: 'cancelled', status: res.status }
          : { taskId, outcome: 'rejected', status: res.status }
      } catch (err) {
        return { taskId, outcome: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )
}
