const SAFE_ERROR_CODE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '登录已过期，请重新登录',
  FORBIDDEN: '当前账号没有执行该操作的权限',
  NOT_FOUND: '请求的记录不存在或已被删除',
  CONFLICT: '数据状态已发生变化，请刷新后重试',
  REVISION_CONFLICT: '配置已被其他人更新，请刷新后重试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  INVALID_INPUT: '输入内容无效，请检查后重试',
  VALIDATION_ERROR: '输入内容无效，请检查后重试',
  INSUFFICIENT_CREDITS: '账户可用积分不足',
}

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
        ? (rawBody as { error?: unknown; code?: unknown })
        : null
    if (status === 401) return '登录已过期，请重新登录'
    if (status === 403) return '当前账号没有执行该操作的权限'
    if (status === 404) return '请求的记录不存在或已被删除'
    if (status === 409) return '数据状态已发生变化，请刷新后重试'
    if (status === 429) return '请求过于频繁，请稍后再试'
    if (status >= 500) return '服务暂时不可用，请稍后重试'
    const code =
      typeof body?.error === 'string'
        ? body.error.trim().toUpperCase()
        : typeof body?.code === 'string'
          ? body.code.trim().toUpperCase()
          : ''
    if (code && code in SAFE_ERROR_CODE_MESSAGES) {
      return SAFE_ERROR_CODE_MESSAGES[code]
    }
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
  }
  return '操作未能完成，请稍后重试'
}
