/**
 * 接口统计：每个后端实例在进程内按分钟累计请求数、错误数与延迟，分钟结束后交给调用方写库。
 * 只数 API 请求——静态资源、健康检查和内部接口不算，它们会把真实用户的情况冲淡。
 *
 * 延迟样本每分钟最多留这么多个，用蓄水池抽样保证超过之后仍然是均匀的；
 * 单实例每分钟的请求量远小于它时，分位数就是精确值。
 */
const SAMPLES_PER_MINUTE = 2000
const MINUTE_MS = 60_000

export interface ApiMinuteRow {
  minute: number
  instance: string
  requests: number
  client_errors: number
  server_errors: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
  server_error_routes: Record<string, number> | null
}

interface Bucket {
  requests: number
  clientErrors: number
  serverErrors: number
  durations: number[]
  maxMs: number
  errorRoutes: Map<string, number>
}

/** 已排序数组的近邻分位数。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil(p * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

/** 不数的路径：健康检查、给采集容器与后台用的内部接口。 */
export function isCountedPath(pathname: string): boolean {
  if (pathname === '/health') return false
  if (pathname.startsWith('/internal/')) return false
  return true
}

export interface ApiMetrics {
  record(entry: { at: number; route: string; status: number; durationMs: number }): void
  /** 取走所有已经结束的分钟；`flushAll` 连当前这一分钟也取走，进程退出前用。 */
  drain(now: number, flushAll?: boolean): ApiMinuteRow[]
}

export function createApiMetrics(instance: string, random: () => number = Math.random): ApiMetrics {
  const buckets = new Map<number, Bucket>()

  return {
    record({ at, route, status, durationMs }) {
      const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS
      let bucket = buckets.get(minute)
      if (!bucket) {
        bucket = {
          requests: 0,
          clientErrors: 0,
          serverErrors: 0,
          durations: [],
          maxMs: 0,
          errorRoutes: new Map(),
        }
        buckets.set(minute, bucket)
      }
      bucket.requests++
      if (status >= 500) {
        bucket.serverErrors++
        bucket.errorRoutes.set(route, (bucket.errorRoutes.get(route) ?? 0) + 1)
      } else if (status >= 400) {
        bucket.clientErrors++
      }
      const ms = Math.max(0, Math.round(durationMs))
      bucket.maxMs = Math.max(bucket.maxMs, ms)
      if (bucket.durations.length < SAMPLES_PER_MINUTE) {
        bucket.durations.push(ms)
      } else {
        const slot = Math.floor(random() * bucket.requests)
        if (slot < SAMPLES_PER_MINUTE) bucket.durations[slot] = ms
      }
    },

    drain(now, flushAll = false) {
      const current = Math.floor(now / MINUTE_MS) * MINUTE_MS
      const rows: ApiMinuteRow[] = []
      for (const [minute, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
        if (!flushAll && minute >= current) continue
        buckets.delete(minute)
        const sorted = [...bucket.durations].sort((a, b) => a - b)
        rows.push({
          minute,
          instance,
          requests: bucket.requests,
          client_errors: bucket.clientErrors,
          server_errors: bucket.serverErrors,
          p50_ms: percentile(sorted, 0.5),
          p95_ms: percentile(sorted, 0.95),
          max_ms: bucket.requests > 0 ? bucket.maxMs : null,
          server_error_routes:
            bucket.errorRoutes.size > 0 ? Object.fromEntries(bucket.errorRoutes) : null,
        })
      }
      return rows
    },
  }
}
