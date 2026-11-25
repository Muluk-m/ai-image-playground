export function formatAdminError(error: unknown): string {
  if (error instanceof Error && error.name === 'UnauthorizedError') {
    return '登录已过期，请重新登录'
  }
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const status = (error as { status: number }).status
    const rawBody = 'body' in error ? (error as { body: unknown }).body : null
    const body =
      rawBody && typeof rawBody === 'object'
        ? (rawBody as { message?: unknown; error?: unknown })
        : null
    if (
      typeof body?.message === 'string' &&
      body.message.trim() &&
      !/^HTTP \d+/i.test(body.message.trim())
    ) {
      return body.message.trim()
    }
    if (status === 401) return '登录已过期，请重新登录'
    if (status === 403) return '当前账号没有执行该操作的权限'
    if (status === 404) return '请求的记录不存在或已被删除'
    if (status === 409) return '数据状态已发生变化，请刷新后重试'
    if (status === 429) return '请求过于频繁，请稍后再试'
    if (status >= 500) return '服务暂时不可用，请稍后重试'
    return '请求未能完成，请检查输入后重试'
  }
  if (error instanceof Error) {
    const msg = error.message.trim()
    if (
      !msg ||
      /failed to fetch|networkerror|load failed|fetch failed|aborted|timeout/i.test(msg)
    ) {
      return '网络连接失败，请检查网络后重试'
    }
    if (/^HTTP \d+/i.test(msg)) {
      return '服务暂时不可用，请稍后重试'
    }
    return msg
  }
  return '操作未能完成，请稍后重试'
}
