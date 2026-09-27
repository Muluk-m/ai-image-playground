import { Elysia } from 'elysia'
import { log } from './logger'

export function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/internal/') ||
    pathname === '/health'
  )
}

interface ApiErrorLogEntry {
  readonly method: string
  readonly path: string
  readonly err: unknown
}

/**
 * 路由里没接住的异常：记下原始错误，只回一个通用 500。Elysia 默认把 `error.message`
 * 原样当响应体，数据库约束名、上游报错都会漏给调用方，而且 pino 里什么也没有。
 * 校验失败、`status()` 显式返回的状态和非 API 路径不经这里。
 */
export function apiErrorHandler(
  record: (entry: ApiErrorLogEntry) => void = (entry) =>
    log.error({ event: 'api.unhandled_error', ...entry }, 'unhandled API error'),
) {
  return new Elysia({ name: 'api-error-handler' }).onError(
    { as: 'global' },
    ({ code, error, request }) => {
      if (code !== 'UNKNOWN' && code !== 'INTERNAL_SERVER_ERROR') return
      const { pathname } = new URL(request.url)
      if (!isApiPath(pathname)) return
      record({ method: request.method, path: pathname, err: error })
      return Response.json({ error: 'internal_error' }, { status: 500 })
    },
  )
}
