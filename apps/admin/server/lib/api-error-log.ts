/**
 * 后台 API 抛错时写一条服务端日志。只记方法、路径、错误信息和 stack。
 * 不记查询串、请求体、cookie 或任何密钥：那些会跟着请求进日志。
 */
export function logAdminApiError(request: Request, error: unknown): void {
  const pathname = new URL(request.url).pathname
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  console.error(
    `[admin] ${request.method} ${pathname} failed: ${message}${stack ? `\n${stack}` : ''}`,
  )
}
