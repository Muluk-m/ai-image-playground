import { AsyncLocalStorage } from 'node:async_hooks'

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
export function withRequestContext(
  handle: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => {
    const incoming = request.headers.get(REQUEST_ID_HEADER)
    const requestId = incoming && ACCEPTED_ID.test(incoming) ? incoming : crypto.randomUUID()
    return context.run({ requestId }, async () => {
      const response = await handle(request)
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
    })
  }
}
