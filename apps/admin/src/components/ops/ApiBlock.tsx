import { OPS_THRESHOLDS } from '@image-playground/shared'

import { Kpi } from '@/components/Kpi'
import { LazyApiTrendChart } from '@/components/ops/LazyApiTrendChart'
import { elapsed } from '@/lib/format'
import type { OpsApi } from '@/lib/types'

function serverErrorRatio(api: OpsApi): number | null {
  const { requests, server_errors } = api.recent
  return requests > 0 ? server_errors / requests : null
}

export function apiProblems(api: OpsApi): string[] {
  const ratio = serverErrorRatio(api)
  if (
    ratio !== null &&
    api.recent.requests >= OPS_THRESHOLDS.API_MIN_REQUESTS_FOR_RATIO &&
    ratio > OPS_THRESHOLDS.API_SERVER_ERROR_RATIO
  ) {
    return [`最近 ${elapsed(api.window_ms)}里 ${Math.round(ratio * 100)}% 的请求返回了 5xx`]
  }
  return []
}

export function ApiBody({ api }: { api: OpsApi }) {
  if (api.series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        还没有接口统计：后端还是不统计接口的旧版本，或者最近一天没有收到请求。
      </p>
    )
  }
  const ratio = serverErrorRatio(api)
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <Kpi
          variant="inline"
          label={`近 ${elapsed(api.window_ms)}请求`}
          value={String(api.recent.requests)}
          note={`4xx ${api.recent.client_errors}`}
        />
        <Kpi
          variant="inline"
          label="5xx"
          value={String(api.recent.server_errors)}
          tone={api.recent.server_errors > 0 ? 'danger' : 'default'}
          note={ratio === null ? '没有请求' : `占 ${(ratio * 100).toFixed(1)}%`}
        />
        <Kpi
          variant="inline"
          label="P95 延迟"
          value={api.recent.p95_ms === null ? '—' : `${api.recent.p95_ms} ms`}
          note="最慢那一分钟"
        />
      </div>
      {api.error_routes.length > 0 ? (
        <div className="border-t pt-3">
          <p className="mb-1 text-xs text-muted-foreground">近 1 小时返回 5xx 的接口</p>
          <ul className="space-y-1 text-xs">
            {api.error_routes.map((route) => (
              <li key={route.route} className="flex items-center justify-between gap-3">
                <span className="truncate font-mono">{route.route}</span>
                <span className="shrink-0 tabular-nums text-danger">{route.count} 次</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {api.series.length > 1 ? (
        <LazyApiTrendChart series={api.series} label="近 24 小时每 15 分钟的请求数与 5xx 数" />
      ) : null}
    </>
  )
}
