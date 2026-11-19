import { AsyncLocalStorage } from 'node:async_hooks'
import { redactLogText } from '@image-playground/shared'
import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { tracer } from './telemetry'

export const REQUEST_ID_HEADER = 'x-request-id'

/** 调用方（网关、前端）带来的 id 只在长得像 id 时沿用，免得把任意内容写进日志和响应头。 */
const ACCEPTED_ID = /^[A-Za-z0-9._-]{8,128}$/

const context = new AsyncLocalStorage<{ readonly requestId: string }>()

/** logger 的 mixin 调它：请求里打的每一行日志都带上这次请求的 id。 */
export function requestLogFields(): { requestId?: string } {
  const store = context.getStore()
  return store ? { requestId: store.requestId } : {}
}

/**
 * 给整个请求套上 request id：沿用或生成、在处理期间对日志可见、写回响应头。
 * 请求里 await 链上发起的后台工作（例如对话轮）通常也带着它；流式响应体里打的日志不保证有。
 */
export function withRequestContext<T extends Response | undefined>(
  handle: (request: Request) => T | Promise<T>,
): (request: Request) => Promise<T | Response> {
  return (request) => {
    const incoming = request.headers.get(REQUEST_ID_HEADER)
    const requestId = incoming && ACCEPTED_ID.test(incoming) ? incoming : crypto.randomUUID()
    const pathname = new URL(request.url).pathname
    // 健康检查、内部接口（采集容器每 2 秒一次）和静态资源不建 span，口径与访问日志一致。
    if (!isTracedPath(pathname))
      return context.run({ requestId }, async () =>
        withRequestIdHeader(await handle(request), requestId),
      )
    // 调用方带了 W3C traceparent 就接着它的链路（是否采样由我们的采样器决定，见 telemetry）。
    // span 只量到响应头返回，流式响应体不计入。
    const parent = propagation.extract(ROOT_CONTEXT, request.headers, headerGetter)
    const span = tracer.startSpan(
      `HTTP ${request.method}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'url.path': pathname,
          'request.id': requestId,
        },
      },
      parent,
    )
    return otelContext.with(trace.setSpan(parent, span), () =>
      context.run({ requestId }, async () => {
        let response: T
        try {
          response = await handle(request)
        } catch (error) {
          // 异常原文可能带 URL 密钥或 Bearer：导出前按服务端日志的规则脱敏，不带堆栈。
          span.recordException({
            name: error instanceof Error ? error.name : 'Error',
            message: redactLogText(error instanceof Error ? error.message : String(error)),
          })
          span.setStatus({ code: SpanStatusCode.ERROR })
          span.end()
          throw error
        }
        // A successful WebSocket upgrade returns no HTTP response.
        if (response) {
          span.setAttribute('http.response.status_code', response.status)
          if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
        }
        span.end()
        return withRequestIdHeader(response, requestId)
      }),
    )
  }
}

/** 建 span 的路径：业务 API。健康检查、`/internal/*` 与静态资源不建。 */
function isTracedPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/v1/')
}

function withRequestIdHeader<T extends Response | undefined>(
  response: T,
  requestId: string,
): T | Response {
  if (!response) return response
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId)
    return response
  } catch {
    // 不可变的响应头（例如直接透传的 fetch 响应）：复制一份再加。
    const headers = new Headers(response.headers)
    headers.set(REQUEST_ID_HEADER, requestId)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

const headerGetter = {
  get: (headers: Headers, key: string) => headers.get(key) ?? undefined,
  keys: (headers: Headers) => [...headers.keys()],
}
