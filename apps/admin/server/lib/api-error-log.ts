import { redactLogText } from '@image-playground/shared'

const BODY_ERROR_CODES = new Set(['VALIDATION', 'PARSE'])

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 后台 API 抛错时写一条服务端日志。只记方法、路径、错误信息和 stack。
 * 不记查询串、请求体、cookie 或任何密钥：那些会跟着请求进日志。
 * 校验和解析错误的 message 里就是请求体，只记错误码。
 */
export function logAdminApiError(request: Request, error: unknown): void {
  const pathname = new URL(request.url).pathname
  const code = errorCode(error)
  if (code === 'NOT_FOUND') {
    console.warn(`WARN [admin] ${request.method} ${pathname} failed: ${code}`)
    return
  }
  if (code && BODY_ERROR_CODES.has(code)) {
    console.error(`[admin] ${request.method} ${pathname} failed: ${code}`)
    return
  }
  const message = redactLogText(error instanceof Error ? error.message : String(error))
  const stack =
    error instanceof Error && error.stack ? redactLogText(error.stack, 0, 16_000) : undefined
  console.error(
    `[admin] ${request.method} ${pathname} failed: ${message}${stack ? `\n${stack}` : ''}`,
  )
}
