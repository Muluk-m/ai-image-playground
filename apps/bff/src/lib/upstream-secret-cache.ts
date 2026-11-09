/**
 * 进程内的后台密钥快照。BFF 和 worker 各自刷新；已经取出的字符串不会被改写，
 * 所以正在发出的上游请求继续用它开始时的那把 key。
 */
let overrides = new Map<string, string>()
let revision = 0

export function upstreamSecretRevision(): number {
  return revision
}

/** Admin override when one is cached; otherwise the caller-supplied env snapshot. */
export function runtimeSecret(envName: string, fallback: string): string {
  const override = overrides.get(envName)
  return override !== undefined ? override : fallback
}

export function replaceUpstreamSecretCache(next: ReadonlyMap<string, string>): void {
  if (
    next.size === overrides.size &&
    [...next].every(([key, value]) => overrides.get(key) === value)
  )
    return
  revision += 1
  overrides = new Map(next)
}

export function resetUpstreamSecretCacheForTests(): void {
  revision += 1
  overrides = new Map()
}
